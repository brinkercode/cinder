// Package loop runs N job slots: claim, heartbeat while working, report once.
package loop

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
)

// Artifacts tokens a job may echo into its output (git errors, harness logs); stripped before the detail is logged or reported.
var artifactsToken = regexp.MustCompile(`art_v1_[0-9A-Za-z\-_]*`)

// Runner holds the loop's settings. Zero durations and a nil Log take the defaults.
type Runner struct {
	Client    *api.Client
	Slots     int
	Heartbeat time.Duration // default 5 min
	Backoff   time.Duration // wait after an empty queue (204) or a claim error; default 30 s
	Exec      func(ctx context.Context, c *api.Claim) api.Report
	Log       *slog.Logger
	// MaxJob ends a job still running after it: the job fails with "timed out after MaxJob". Zero is no limit.
	// The heartbeat keeps a job's lease alive, so without it a job blocked anywhere holds its worker forever.
	// An agent job's own max_minutes, when set, replaces it.
	MaxJob time.Duration
}

// minute is one agent max_minutes unit; tests shorten it.
var minute = time.Minute

// Run blocks until ctx is cancelled and every slot has reported its job.
// A slot whose claim is rejected stops; once every slot has, Run returns api.ErrUnauthorized.
func (r *Runner) Run(ctx context.Context) error {
	if r.Slots < 1 || r.Client == nil || r.Exec == nil {
		return errors.New("loop: Slots >= 1, Client and Exec are required")
	}
	r.Heartbeat = cmp.Or(r.Heartbeat, 5*time.Minute)
	r.Backoff = cmp.Or(r.Backoff, 30*time.Second)
	r.Log = cmp.Or(r.Log, slog.Default())
	unauthorized := make(chan error, r.Slots)
	var wg sync.WaitGroup
	for range r.Slots {
		wg.Go(func() {
			for ctx.Err() == nil {
				c, err := r.Client.Claim(ctx)
				if errors.Is(err, api.ErrUnauthorized) {
					unauthorized <- err
					return
				}
				if err != nil && ctx.Err() == nil {
					r.Log.Error("claim failed", "err", err)
				}
				if err == nil && c != nil {
					r.work(ctx, c)
					continue
				}
				select {
				case <-ctx.Done():
				case <-time.After(r.Backoff):
				}
			}
		})
	}
	wg.Wait()
	select {
	case err := <-unauthorized:
		return err
	default:
		return nil
	}
}

func (r *Runner) work(ctx context.Context, c *api.Claim) {
	id := c.Job.ID
	done := make(chan api.Report, 1)
	jctx, kill := context.WithCancel(ctx)
	defer kill()
	limit := r.MaxJob
	if c.Agent != nil && c.Agent.Limits.MaxMinutes > 0 {
		limit = time.Duration(c.Agent.Limits.MaxMinutes) * minute
	}
	if limit > 0 {
		var stop context.CancelFunc
		jctx, stop = context.WithTimeout(jctx, limit)
		defer stop()
	}
	defer gitauth.Refresh(string(c.GitToken), "")
	defer gitauth.Refresh(string(c.ReadToken), "")
	go func() { done <- r.Exec(jctx, c) }()
	t := time.NewTicker(r.Heartbeat)
	defer t.Stop()
	var rep api.Report
	// A shutdown (a deploy rolling the container) that lands mid-job means its report would be the interruption,
	// not the job's result: nothing is reported, and the job returns to the queue when its lease expires.
	shutdown, interrupted := ctx.Done(), false
	for running := true; running; {
		select {
		case rep = <-done:
			running = false
		case <-shutdown:
			shutdown, interrupted = nil, true
		case <-t.C:
			b, err := r.Client.Heartbeat(ctx, id)
			if err != nil && ctx.Err() == nil {
				r.Log.Error("heartbeat failed", "job", id, "err", err)
			}
			// The claim's tokens last 10 minutes; git commands from here on send the heartbeat's.
			if err == nil && b.Token != "" {
				gitauth.Refresh(string(c.GitToken), string(b.Token))
			}
			if err == nil && b.ReadToken != "" {
				gitauth.Refresh(string(c.ReadToken), string(b.ReadToken))
			}
			if b.Cancel {
				kill()
			}
		}
	}
	if interrupted {
		r.Log.Warn("shutdown interrupted the job; not reported, its lease returns it to the queue", "job", id, "kind", c.Job.Kind)
		return
	}
	if errors.Is(jctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
		rep = api.Report{Status: "failed", Detail: "timed out after " + limit.String()}
	} else if jctx.Err() != nil && ctx.Err() == nil {
		rep = api.Report{Status: "cancelled"}
	}
	rep.Detail = artifactsToken.ReplaceAllString(rep.Detail, "[redacted]")
	// The report goes out even when shutdown cancelled ctx after the job finished, so a finished job is never lost.
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := r.Client.Report(rctx, id, rep); err != nil {
		r.Log.Error("report failed", "job", id, "err", err)
		return
	}
	r.Log.Info("job reported", "job", id, "kind", c.Job.Kind, "status", rep.Status, "detail", rep.Detail)
}
