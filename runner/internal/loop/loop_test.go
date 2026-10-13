package loop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/harness"
)

// fakeAPI is an httptest Worker: it hands out queued jobs, then answers 204.
type fakeAPI struct {
	sync.Mutex
	queue               []string
	token               string
	reports, heartbeats map[string]int
	empty               int
	done                func(*fakeAPI) bool
	stop                func()
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Lock()
	defer f.Unlock()
	p := strings.Split(r.URL.Path, "/") // /api/work/claim or /api/work/jobs/{id}/{action}
	switch path := r.URL.Path; {
	case path == "/api/work/jobs/"+p[len(p)-2]+"/heartbeat":
		f.heartbeats[p[len(p)-2]]++
	case path == "/api/work/jobs/"+p[len(p)-2]+"/report":
		f.reports[p[len(p)-2]]++
	case path != "/api/work/claim":
		http.NotFound(w, r)
	case len(f.queue) == 0:
		f.empty++
		w.WriteHeader(http.StatusNoContent)
	default:
		fmt.Fprintf(w, `{"token":%q,"job":{"id":%q,"repo_id":"r1","kind":"develop","change_id":"c1","status":"claimed",`+
			`"runner_id":"run1","lease_expires_at":"2026-10-04T12:00:00Z","created_at":"2026-10-04T10:00:00Z"}}`, f.token, f.queue[0])
		f.queue = f.queue[1:]
	}
	if f.done(f) {
		f.stop()
	}
}

// runUntil runs r against a fakeAPI with ids queued until done holds, then shuts it down.
func runUntil(t *testing.T, r *Runner, token string, ids []string, done func(f *fakeAPI) bool) *fakeAPI {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	f := &fakeAPI{queue: ids, token: token, reports: map[string]int{}, heartbeats: map[string]int{}, done: done, stop: cancel}
	srv := httptest.NewServer(f)
	r.Client = &api.Client{BaseURL: srv.URL, Token: "api"}
	r.Run(ctx)
	srv.Close() // waits for in-flight handlers
	if !done(f) {
		t.Fatal("timed out")
	}
	return f
}

func TestRun_OneReportPerJob_SlowHost_StillSendsHeartbeat(t *testing.T) {
	var fake atomic.Pointer[fakeAPI] // set by done, which runs on the claim that hands out each job
	r := &Runner{Slots: 2, Heartbeat: 10 * time.Millisecond, Backoff: 50 * time.Millisecond, Log: slog.New(slog.DiscardHandler),
		Exec: func(ctx context.Context, c *api.Claim) api.Report {
			// Hold until the fake has seen this job's heartbeat: a fixed sleep races the ticker on a loaded host.
			for {
				f := fake.Load()
				f.Lock()
				beats := f.heartbeats[c.Job.ID]
				f.Unlock()
				if beats > 0 {
					return api.Report{Status: "done"}
				}
				select {
				case <-ctx.Done():
					return api.Report{Status: "failed"}
				case <-time.After(5 * time.Millisecond):
				}
			}
		}}
	f := runUntil(t, r, "tok", []string{"j1", "j2", "j3"}, func(f *fakeAPI) bool { fake.Store(f); return f.empty >= 4 })
	for _, id := range []string{"j1", "j2", "j3"} {
		if f.reports[id] != 1 || f.heartbeats[id] == 0 {
			t.Errorf("job %s: %d reports, %d heartbeats; want 1 report and >= 1 heartbeat", id, f.reports[id], f.heartbeats[id])
		}
	}
	if f.empty > 10 { // 2 slots backing off 50 ms: a hot loop on 204 claims far more
		t.Errorf("empty claims = %d, slots did not back off on 204", f.empty)
	}
}

func TestRun_ThreeSlotsRunThreeJobsConcurrently(t *testing.T) {
	var running atomic.Int32
	all := make(chan struct{})
	r := &Runner{Slots: 3, Backoff: 10 * time.Millisecond, Log: slog.New(slog.DiscardHandler),
		Exec: func(context.Context, *api.Claim) api.Report {
			if running.Add(1) == 3 {
				close(all)
			}
			select { // hold the slot until all three jobs run at once
			case <-all:
				return api.Report{Status: "done"}
			case <-time.After(5 * time.Second): // ran alone: no longer counts as running
				running.Add(-1)
				return api.Report{Status: "failed"}
			}
		}}
	runUntil(t, r, "tok", []string{"j1", "j2", "j3"}, func(f *fakeAPI) bool { return len(f.reports) == 3 })
	if running.Load() != 3 {
		t.Fatalf("3 jobs did not run concurrently on 3 slots (%d running)", running.Load())
	}
}

func TestRun_NoTokenInArgvOrLogOutput(t *testing.T) {
	const token = "artifacts-secret-7f3a"
	var sawHeader atomic.Bool
	git := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawHeader.CompareAndSwap(false, r.Header.Get("Authorization") == "Bearer "+token)
		http.NotFound(w, r)
	}))
	defer git.Close()
	var logs bytes.Buffer
	var argv []string
	log := slog.New(slog.NewTextHandler(&logs, nil))
	r := &Runner{Slots: 1, Backoff: 10 * time.Millisecond, Log: log,
		Exec: func(ctx context.Context, c *api.Claim) api.Report {
			cmd := gitauth.Command(ctx, string(c.GitToken), "ls-remote", git.URL+"/repo.git")
			argv = cmd.Args
			out, _ := cmd.CombinedOutput()
			log.Info("claim", "claim", c, "token", c.GitToken) // a careless log line
			return api.Report{Status: "failed", Detail: string(out)}
		}}
	runUntil(t, r, token, []string{"j1"}, func(f *fakeAPI) bool { return f.reports["j1"] == 1 })
	if !sawHeader.Load() {
		t.Fatal("git did not send the token as http.extraHeader from env")
	}
	if strings.Contains(strings.Join(argv, " "), token) {
		t.Errorf("token in argv: %q", argv)
	}
	if !strings.Contains(logs.String(), "job reported") || strings.Contains(logs.String(), token) {
		t.Errorf("token in log output, or job not logged:\n%s", logs.String())
	}
}

func TestRun_NoArtifactsTokenInLogs(t *testing.T) {
	var logs bytes.Buffer
	r := &Runner{Slots: 1, Backoff: 10 * time.Millisecond, Log: slog.New(slog.NewTextHandler(&logs, nil)),
		Exec: func(context.Context, *api.Claim) api.Report {
			// A harness that echoes a token it found, e.g. in a remote URL.
			return api.Report{Status: "failed", Detail: "fatal: https://x:art_v1_Ab3-_9zQ7kLm2PqRsTuVwXy@artifacts/repo.git refused"}
		}}
	runUntil(t, r, "tok", []string{"j1"}, func(f *fakeAPI) bool { return f.reports["j1"] == 1 })
	if !strings.Contains(logs.String(), "refused") || strings.Contains(logs.String(), "art_v1_") {
		t.Errorf("art_v1_ token in log output, or detail not logged:\n%s", logs.String())
	}
}

func TestHeartbeat_CancelTrue_KillsHarness(t *testing.T) {
	// The fake harness leaves a child holding its output pipe: only killing the process group lets Run return.
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nsleep 30 &\nwait\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	reported := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			fmt.Fprint(w, `{"lease_expires_at":"2026-10-04T12:00:00Z","cancel":true}`)
		case strings.HasSuffix(r.URL.Path, "/report"):
			var rep api.Report
			_ = json.NewDecoder(r.Body).Decode(&rep)
			reported <- rep.Status
			w.WriteHeader(http.StatusConflict)
		}
	}))
	defer srv.Close()
	r := &Runner{Client: &api.Client{BaseURL: srv.URL}, Heartbeat: 10 * time.Millisecond, Log: slog.New(slog.DiscardHandler),
		Exec: func(ctx context.Context, _ *api.Claim) api.Report {
			_, err := harness.Run(ctx, harness.Spec{Prompt: "x"})
			return api.Report{Status: "failed", Detail: fmt.Sprint(err)}
		}}
	go r.work(context.Background(), &api.Claim{Job: api.Job{ID: "j1", Kind: "develop"}})
	select {
	case s := <-reported:
		if s != "cancelled" {
			t.Errorf("reported %q, want cancelled", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("harness still running 5s after the heartbeat said cancel")
	}
}

// A job blocked where no step timeout reaches it (a Worker call that never answers) keeps its lease through the
// heartbeat; MaxJob ends it and it fails with the limit as its reason.
func TestWork_JobOverMaxJob_ReportsTimedOut(t *testing.T) {
	reported := make(chan api.Report, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			fmt.Fprint(w, `{"lease_expires_at":"2026-10-04T12:00:00Z","cancel":false}`)
		case strings.HasSuffix(r.URL.Path, "/report"):
			var rep api.Report
			_ = json.NewDecoder(r.Body).Decode(&rep)
			reported <- rep
		}
	}))
	defer srv.Close()
	r := &Runner{Client: &api.Client{BaseURL: srv.URL}, Heartbeat: 10 * time.Millisecond, MaxJob: 100 * time.Millisecond,
		Log: slog.New(slog.DiscardHandler),
		Exec: func(jctx context.Context, _ *api.Claim) api.Report {
			<-jctx.Done() // blocked until the limit
			return api.Report{Status: "failed", Detail: "interrupted"}
		}}
	go r.work(context.Background(), &api.Claim{Job: api.Job{ID: "j1", Kind: "flow"}})
	select {
	case rep := <-reported:
		if rep.Status != "failed" || rep.Detail != "timed out after 100ms" {
			t.Errorf("reported %+v, want failed: timed out after 100ms", rep)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("job still running 5s past MaxJob")
	}
}

// An agent job runs to its version's max_minutes, not the runner's MaxJob, and fails as timed out past it.
func TestWork_AgentJobOverMaxMinutes_ReportsTimedOut(t *testing.T) {
	defer func(m time.Duration) { minute = m }(minute)
	minute = 50 * time.Millisecond
	reported := make(chan api.Report, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			fmt.Fprint(w, `{"lease_expires_at":"2026-10-04T12:00:00Z","cancel":false}`)
		case strings.HasSuffix(r.URL.Path, "/report"):
			var rep api.Report
			_ = json.NewDecoder(r.Body).Decode(&rep)
			reported <- rep
		}
	}))
	defer srv.Close()
	r := &Runner{Client: &api.Client{BaseURL: srv.URL}, Heartbeat: 10 * time.Millisecond, MaxJob: time.Hour,
		Log: slog.New(slog.DiscardHandler),
		Exec: func(jctx context.Context, _ *api.Claim) api.Report {
			<-jctx.Done() // a harness that never answers
			return api.Report{Status: "failed", Detail: "interrupted"}
		}}
	agent := &api.Agent{Agent: "developer", Version: 2}
	agent.Limits.MaxMinutes = 2
	go r.work(context.Background(), &api.Claim{Job: api.Job{ID: "j1", Kind: "develop"}, Agent: agent})
	select {
	case rep := <-reported:
		if rep.Status != "failed" || rep.Detail != "timed out after 100ms" {
			t.Errorf("reported %+v, want failed: timed out after 100ms", rep)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent job still running 5s past its max_minutes")
	}
}

func TestRun_Report409_LogsWorkerReason(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	claimed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/work/jobs/j1/report":
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"error":{"code":"change_moved","message":"change c1 is no longer in a state that can move to verifying"}}`)
			cancel()
		case !claimed:
			claimed = true
			fmt.Fprint(w, `{"job":{"id":"j1","repo_id":"r1","kind":"develop","change_id":"c1","status":"claimed",`+
				`"runner_id":"run1","lease_expires_at":"2026-10-04T12:00:00Z","created_at":"2026-10-04T10:00:00Z"}}`)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()
	var logs bytes.Buffer
	r := &Runner{Client: &api.Client{BaseURL: srv.URL, Token: "api"}, Slots: 1, Backoff: 10 * time.Millisecond,
		Log:  slog.New(slog.NewTextHandler(&logs, nil)),
		Exec: func(context.Context, *api.Claim) api.Report { return api.Report{Status: "done"} }}
	_ = r.Run(ctx)
	if !strings.Contains(logs.String(), "change_moved") {
		t.Fatalf("logs = %q, want the worker's reason change_moved", logs.String())
	}
}

func TestRun_RevokedToken_ExitsNonZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r := &Runner{Client: &api.Client{BaseURL: srv.URL, Token: "revoked"}, Slots: 2, Backoff: 10 * time.Millisecond, Log: slog.New(slog.DiscardHandler),
		Exec: func(context.Context, *api.Claim) api.Report { return api.Report{Status: "done"} }}
	err := r.Run(ctx)
	if !errors.Is(err, api.ErrUnauthorized) {
		t.Fatalf("Run = %v, want ErrUnauthorized", err)
	}
	if ctx.Err() != nil {
		t.Fatal("Run kept retrying until the deadline instead of exiting")
	}
}

func TestWork_ShutdownMidJob_IsNotReported(t *testing.T) {
	var reports atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/report") {
			reports.Add(1)
		}
	}))
	defer srv.Close()
	ctx, shutdown := context.WithCancel(context.Background())
	started := make(chan struct{})
	r := &Runner{Client: &api.Client{BaseURL: srv.URL}, Heartbeat: time.Hour, Log: slog.New(slog.DiscardHandler),
		Exec: func(jctx context.Context, _ *api.Claim) api.Report {
			close(started)
			<-jctx.Done()
			return api.Report{Status: "failed", Detail: "check timed out after 15m0s"}
		}}
	finished := make(chan struct{})
	go func() { r.work(ctx, &api.Claim{Job: api.Job{ID: "j1", Kind: "verify"}}); close(finished) }()
	<-started
	shutdown()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("work still running 5s after shutdown")
	}
	if n := reports.Load(); n != 0 {
		t.Fatalf("an interrupted job sent %d report(s), want none", n)
	}
}
