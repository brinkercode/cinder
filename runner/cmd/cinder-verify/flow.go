package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/egress"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/mask"
	"github.com/brinkercode/cinder/runner/internal/testreport"
	"github.com/brinkercode/cinder/runner/internal/verify"
)

// stepPoll is how often a step the Worker drives is polled; an approval may wait hours.
const stepPoll = 5 * time.Second

// A flow has no timeout field yet, so every step gets stepTimeout (set up included) and the checkout gets gitTimeout;
// a hung one fails with a message and frees the worker. Vars so tests can shorten them.
// lazy: one limit for every step, add a per-step `timeout` to the flow schema when a step needs another.
var (
	stepTimeout = 30 * time.Minute
	gitTimeout  = 5 * time.Minute
)

// runFlow checks out the flow's sha and runs its steps. A step starts once every step it needs has passed, so steps
// with no order between them run in parallel; a step whose need didn't pass is skipped. Each step's status goes to the
// Worker as it changes; the run is done only when every step passed. A step without a run command (a Cloudflare deploy,
// a cloudflare/workflow or an approval) is handed to the Worker, which drives it while this worker polls.
// Steps reach the network through an egress proxy applying the pool's egress; its counts go in the report.
func runFlow(ctx context.Context, client *api.Client, c *api.Claim) (r api.Report) {
	var p struct {
		RunID   string            `json:"run_id"` // set on one flow job of a run, whose steps run in order (runJob)
		Key     string            `json:"key"`    // the job's stage/name in its run
		Flow    string            `json:"flow"`
		Leg     string            `json:"leg"` // "<k> <v>[, …][, i/n]": the job's matrix values, then its shard
		Sha     string            `json:"sha"`
		Env     map[string]string `json:"env"`
		Secrets []string          `json:"secrets"`
		Steps   []flowStep        `json:"steps"`
	}
	if err := json.Unmarshal(c.Payload, &p); err != nil || p.Sha == "" || len(p.Steps) == 0 {
		return api.Report{Status: "failed", Detail: "cinder-verify: flow payload needs sha and steps"}
	}
	// A job logs the runner's own steps, numbered after its steps so theirs stay put: Set up job, Complete job,
	// Checkout, Upload artifacts. cur is the one in progress, which stop fails.
	began := time.Now()
	cur := startStep(context.WithoutCancel(ctx), client, c.Job.ID, len(p.Steps), "Set up job")
	// A run that stops before any step starts would otherwise show every step queued with no reason.
	stop := func(why string) api.Report {
		if cur != nil {
			_ = cur.end(why) // the run already fails with why
		}
		for _, s := range p.Steps {
			_ = client.Step(ctx, c.Job.ID, s.Name, "failed", why)
		}
		return api.Report{Status: "failed", Detail: why}
	}
	dir, err := os.MkdirTemp("", "cinder-flow-")
	if err != nil {
		return api.Report{Status: "failed", Detail: err.Error()}
	}
	defer os.RemoveAll(dir)
	// Steps get the flow's env and nothing of the runner's but PATH and HOME, so the runner token never reaches them (plus the CA files).
	env := verify.BaseEnv()
	for k, v := range p.Env {
		env = append(env, k+"="+v)
	}
	// A leg learns its slice: CINDER_LEG, CINDER_MATRIX_<KEY> per matrix value and CINDER_SHARD_INDEX (1-based) / _COUNT.
	if p.Leg != "" {
		env = append(env, "CINDER_LEG="+p.Leg)
		for _, part := range strings.Split(p.Leg, ", ") {
			if i, n, ok := strings.Cut(part, "/"); ok {
				env = append(env, "CINDER_SHARD_INDEX="+i, "CINDER_SHARD_COUNT="+n)
			} else if k, v, ok := strings.Cut(part, " "); ok {
				env = append(env, "CINDER_MATRIX_"+strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(k))+"="+v)
			}
		}
	}
	// cinder and Artifacts are always allowed; none drops the pool's patterns, open lets every host through.
	host := func(s string) string {
		if u, err := url.Parse(s); err == nil {
			return u.Hostname()
		}
		return ""
	}
	allow := c.Egress.Allow
	if c.Egress.Mode == "none" {
		allow = nil
	}
	proxy, err := egress.Start(allow, c.Egress.Mode == "open", host(client.BaseURL), host(c.TargetRemote))
	if err != nil {
		return stop("egress proxy: " + err.Error())
	}
	defer func() {
		allowed, denied := proxy.Counts()
		r.Egress = &api.Egress{Allowed: allowed, Denied: denied, WouldDeny: proxy.WouldDeny()}
		proxy.Close()
	}()
	env = append(env, "HTTPS_PROXY="+proxy.URL, "HTTP_PROXY="+proxy.URL)
	// Flow secrets come from the keystore (Secrets Store), read for this job's lease; they are masked like env values.
	secrets := []string{}
	for _, name := range p.Secrets {
		v, err := client.JobSecret(ctx, c.Job.ID, name)
		if err != nil {
			return stop("secret " + name + ": " + err.Error() + " (save it in Keystore for this repo or flow)")
		}
		env = append(env, name+"="+string(v))
		secrets = append(secrets, string(v))
	}
	masked := slices.Concat(slices.Collect(maps.Values(p.Env)), secrets)
	var setupErr error
	if cur != nil {
		setupErr = setUp(cur, c, cmp.Or(p.Key, p.Flow), p.Sha, dir, p.Env, p.Secrets, masked)
		cur = startStep(context.WithoutCancel(ctx), client, c.Job.ID, len(p.Steps)+2, "Checkout")
		repo := c.TargetRemote
		if u, err := url.Parse(repo); err == nil {
			repo = u.Redacted()
		}
		fmt.Fprintf(cur, "Repository: %s\nCommit: %s\nDepth: full history\n", repo, p.Sha)
	}
	start := time.Now()
	gctx, stopGit := context.WithTimeout(ctx, gitTimeout)
	defer stopGit()
	for _, args := range [][]string{{"clone", "-q", "--", c.TargetRemote, dir}, {"-C", dir, "checkout", "-q", "--detach", p.Sha}} {
		if out, err := gitauth.Command(gctx, string(c.ReadToken), args...).CombinedOutput(); err != nil {
			if gctx.Err() == context.DeadlineExceeded && ctx.Err() == nil {
				err = fmt.Errorf("timed out after %s", gitTimeout)
			}
			return stop(fmt.Sprintf("git: %v\n%s", err, out))
		}
	}
	if cur != nil {
		fmt.Fprintf(cur, "Fetched in %s\n", time.Since(start).Round(time.Millisecond))
		if p.RunID != "" {
			return runJob(ctx, client, c.Job.ID, dir, env, masked, p.Steps, errors.Join(setupErr, cur.end("")))
		}
		setupErr = errors.Join(setupErr, cur.end(""))
	}

	type result struct {
		done   chan struct{}
		passed bool
	}
	results := map[string]*result{}
	for _, s := range p.Steps {
		results[s.Name] = &result{done: make(chan struct{})}
	}
	var mu sync.Mutex
	var problems []string
	var wg sync.WaitGroup
	// lazy: parallel steps share one checkout; give each its own worktree if steps start writing over each other.
	for i, s := range p.Steps {
		wg.Go(func() {
			r := results[s.Name]
			defer close(r.done)
			report := func(status, logs string, missing ...string) {
				if err := client.Step(ctx, c.Job.ID, s.Name, status, logs, missing...); err != nil {
					mu.Lock()
					problems = append(problems, err.Error())
					mu.Unlock()
				}
			}
			for _, n := range s.Needs {
				// A need missing from the flow counts as not passed (the Worker validates needs, so this is a corrupt payload).
				need := results[n]
				if need != nil {
					<-need.done
				}
				if need == nil || !need.passed {
					report("skipped", "needs "+n+", which did not pass")
					return
				}
			}
			stepEnv, stepMasked, missing, err := stepSecrets(ctx, client, c.Job.ID, s, masked)
			if err != nil {
				report("failed", err.Error()+"\n", missing...)
				return
			}
			if s.driven() {
				status, err := drive(ctx, client, c.Job.ID, s.Name, io.Discard)
				if err != nil {
					report("failed", err.Error())
				}
				r.passed = status == "passed"
				return
			}
			report("running", "")
			// Each line also streams to the step's paged log, flushed whole before its status is reported.
			var buf bytes.Buffer
			log := newStepLog(context.WithoutCancel(ctx), client, c.Job.ID, i, s.Name)
			err = execStep(ctx, client, dir, slices.Concat(env, stepEnv), stepMasked, s, io.MultiWriter(&buf, log), false)
			why := ""
			if err != nil {
				why = err.Error()
			}
			if lerr := log.close(why); lerr != nil {
				mu.Lock()
				problems = append(problems, lerr.Error())
				mu.Unlock()
			}
			out := buf.Bytes()
			logs := string(out[max(0, len(out)-64<<10):]) // the Worker keeps the last 64 KB
			if err != nil {
				report("failed", logs+err.Error()+"\n")
				return
			}
			r.passed = true
			report("passed", logs)
		})
	}
	wg.Wait()
	for _, s := range p.Steps {
		if !results[s.Name].passed {
			problems = append(problems, "step "+s.Name+" did not pass")
		}
	}
	done := startStep(context.WithoutCancel(ctx), client, c.Job.ID, len(p.Steps)+1, "Complete job")
	fmt.Fprintf(done, "Steps took %s\n", time.Since(began).Round(time.Second))
	_ = errors.Join(setupErr, done.end("")) // the runner's own steps are a view; the steps' reports decide the job
	if len(problems) > 0 {
		return api.Report{Status: "failed", Detail: strings.Join(problems, "\n")}
	}
	return api.Report{Status: "done"}
}

// flowStep is one step of a flow job's payload. A step without a run command (a Cloudflare deploy, a
// cloudflare/workflow or an approval) is driven by the Worker.
type flowStep struct {
	Name  string   `json:"name"`
	Run   string   `json:"run"`
	Needs []string `json:"needs"`
	// Secrets are this step's own keystore names, read just before it runs; a missing one fails this step alone.
	Secrets []string `json:"secrets"`
	// Setup is tool → version, put on the step's PATH before it runs (toolcache.go).
	Setup map[string]string `json:"setup"`
	// AWS, GCP, Azure or SSH is set for a deploy step to that target, which this worker runs (targetScript).
	AWS   *target `json:"aws"`
	GCP   *target `json:"gcp"`
	Azure *target `json:"azure"`
	SSH   *target `json:"ssh"`
	// Junit and Artifacts are files in the checkout sent to the Worker once the step ends (results).
	Junit     paths `json:"junit"`
	Artifacts paths `json:"artifacts"`
}

// paths is a step's file list, written as one path or a list of them.
type paths []string

func (p *paths) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*p = paths{one}
		return nil
	}
	return json.Unmarshal(b, (*[]string)(p))
}

// results posts each junit: file of step s as a test suite and uploads each artifacts: file, logging each to log. A
// file that can't be read or sent is logged and doesn't change any step's status.
func results(ctx context.Context, client *api.Client, jobID, dir string, s flowStep, log io.Writer) {
	for _, p := range s.Junit {
		if err := postSuite(ctx, client, jobID, filepath.Join(dir, p), p); err != nil {
			fmt.Fprintf(log, "junit %s: %v\n", p, err)
		} else {
			fmt.Fprintf(log, "Sent test report %s of step %s\n", p, s.Name)
		}
	}
	for _, p := range s.Artifacts {
		if err := putArtifact(ctx, client, jobID, filepath.Join(dir, p)); err != nil {
			fmt.Fprintf(log, "artifact %s: %v\n", p, err)
		} else {
			fmt.Fprintf(log, "Uploaded artifact %s of step %s\n", p, s.Name)
		}
	}
}

// postSuite parses the JUnit file at path and posts its counts and failed tests as suite.
func postSuite(ctx context.Context, client *api.Client, jobID, path, suite string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var r testreport.Report
	if err := r.AddJUnit(b); err != nil {
		return err
	}
	passed, failed, skipped, failures := 0, 0, 0, []string{}
	for _, t := range r.Tests {
		switch t.Status {
		case "pass":
			passed++
		case "fail":
			failed++
			failures = append(failures, t.Test)
		default:
			skipped++
		}
	}
	return client.Post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/tests", map[string]any{
		"suite": suite, "passed": passed, "failed": failed, "skipped": skipped, "failures": failures})
}

// putArtifact streams the file at path to the Worker under its base name.
func putArtifact(ctx context.Context, client *api.Client, jobID, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, client.BaseURL+"/api/work/jobs/"+url.PathEscape(jobID)+"/artifacts/"+url.PathEscape(filepath.Base(path)), f)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size() // R2 takes a stream only of known length
	resp, err := workerDo(client, req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("upload: status %d", resp.StatusCode)
	}
	return nil
}

// driven says the Worker runs step s: a Cloudflare deploy, a cloudflare/workflow or an approval.
func (s flowStep) driven() bool {
	kind, _ := s.target()
	return s.Run == "" && kind == ""
}

// runJob runs one flow job of a run: its steps in order, each one's status, log lines and annotations streamed to the
// Worker as it goes. A step that doesn't pass skips the rest; a cancelled job stops its running step.
func runJob(ctx context.Context, client *api.Client, jobID, dir string, env, masked []string, steps []flowStep, setupErr error) api.Report {
	start := time.Now()
	// Posts outlive a cancelled job, so a cancelled step still sends its last lines and status.
	post := context.WithoutCancel(ctx)
	var problems []string
	note := func(err error) {
		if err != nil {
			problems = append(problems, err.Error())
		}
	}
	note(setupErr)
	stopped := false
	var ran []flowStep // the steps that started, whose files Upload artifacts sends
	for i, s := range steps {
		if stopped {
			note(client.StepStatus(post, jobID, i, "skipped", nil))
			continue
		}
		note(client.StepStatus(post, jobID, i, "running", nil))
		log := newStepLog(post, client, jobID, i, s.Name)
		stepEnv, stepMasked, missing, err := stepSecrets(ctx, client, jobID, s, masked)
		if err == nil && s.driven() {
			var status string
			if status, err = drive(ctx, client, jobID, s.Name, log); err == nil && status != "passed" {
				err = fmt.Errorf("step %s %s", s.Name, status)
			}
		} else if err == nil {
			err = execStep(ctx, client, dir, slices.Concat(env, stepEnv), stepMasked, s, log, true)
		}
		ran = append(ran, s)
		why := ""
		if err != nil {
			why = err.Error()
		}
		note(log.close(why))
		var code *int
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = new(exit.ExitCode())
		} else if err == nil && !s.driven() {
			code = new(0)
		}
		status := "passed"
		if ctx.Err() != nil {
			status = "cancelled"
		} else if err != nil {
			status = "failed"
		}
		note(client.StepStatus(post, jobID, i, status, code))
		if status != "cancelled" {
			// driveStep checks a step's needs in flow_steps, which only Step writes.
			note(client.Step(post, jobID, s.Name, status, "", missing...))
		}
		if stopped = status != "passed"; stopped {
			problems = append(problems, "step "+s.Name+" "+status)
		}
	}
	// Post steps run after a failed step too; a cancelled job sends nothing more.
	if ctx.Err() == nil && slices.ContainsFunc(ran, func(s flowStep) bool { return len(s.Junit)+len(s.Artifacts) > 0 }) {
		up := startStep(post, client, jobID, len(steps)+3, "Upload artifacts")
		for _, s := range ran {
			results(post, client, jobID, dir, s, up)
		}
		note(up.end(""))
	}
	done := startStep(post, client, jobID, len(steps)+1, "Complete job")
	why := ""
	if err := os.RemoveAll(dir); err != nil {
		why = err.Error()
	} else {
		fmt.Fprintf(done, "Removed workspace %s\nSteps took %s\n", dir, time.Since(start).Round(time.Second))
	}
	note(done.end(why))
	if len(problems) > 0 {
		return api.Report{Status: "failed", Detail: strings.Join(problems, "\n")}
	}
	return api.Report{Status: "done"}
}

// setUp logs what the runner set up for job c into its Set up job step and ends it: env with every value in masked
// shown as ***, the secrets by name only.
func setUp(l *stepLog, c *api.Claim, key, sha, dir string, env map[string]string, secrets, masked []string) error {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		fmt.Fprintf(l, "Current runner version: '%s'\n", info.Main.Version)
	}
	if c.Job.RunnerID != nil {
		fmt.Fprintf(l, "Runner name: '%s'\n", *c.Job.RunnerID)
	}
	fmt.Fprintf(l, "Operating system: %s/%s · %d CPUs\n", runtime.GOOS, runtime.GOARCH, runtime.NumCPU())
	fmt.Fprintf(l, "Repository token: read-only, for the checkout\nEgress: %s · allow %s\n", cmp.Or(c.Egress.Mode, "allowlist"), cmp.Or(strings.Join(c.Egress.Allow, ", "), "cinder and the repository only"))
	if len(secrets) > 0 {
		fmt.Fprintf(l, "Secret source: Keystore · injected %d (%s)\n", len(secrets), strings.Join(secrets, ", "))
	}
	m := mask.New(l)
	for _, v := range masked {
		_ = m.Add(v) // lazy: values under 8 characters are refused, as in step logs
	}
	fmt.Fprintln(m, "##[group]Environment")
	for _, k := range slices.Sorted(maps.Keys(env)) {
		fmt.Fprintf(m, "%s=%s\n", k, env[k])
	}
	for _, k := range secrets {
		fmt.Fprintf(m, "%s=***\n", k)
	}
	fmt.Fprintln(m, "##[endgroup]")
	_ = m.Close() // writes to a stepLog, which never fails
	fmt.Fprintf(l, "Prepared workflow directory %s at %s\nComplete job name: %s\n", dir, sha, key)
	return l.end("")
}

// startStep records step idx of job running and returns its log, which end closes.
func startStep(ctx context.Context, client *api.Client, job string, idx int, name string) *stepLog {
	err := client.StepStatus(ctx, job, idx, "running", nil)
	l := newStepLog(ctx, client, job, idx, name)
	l.mu.Lock()
	l.err = err
	l.mu.Unlock()
	return l
}

// end closes l's log and records its step passed, or failed with why; it returns the first post that failed.
func (l *stepLog) end(why string) error {
	status := "passed"
	if why != "" {
		status = "failed"
	}
	return cmp.Or(l.close(why), l.client.StepStatus(l.ctx, l.job, l.idx, status, nil))
}

// drive hands step name to the Worker and polls it until it passes or fails, writing each new log it answers to out.
func drive(ctx context.Context, client *api.Client, jobID, name string, out io.Writer) (string, error) {
	last := ""
	for {
		status, logs, err := client.DriveStep(ctx, jobID, name)
		if err != nil {
			return "", err
		}
		if logs != "" && logs != last {
			_, _ = fmt.Fprintln(out, logs) // a stepLog or io.Discard, neither of which fails
			last = logs
		}
		if status != "running" {
			return status, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(stepPoll):
		}
	}
}

// stepSecrets reads step s's own keystore secrets and its deploy target's credential as env entries, and returns
// masked with their values added. missing names those it could not read, and err says so.
func stepSecrets(ctx context.Context, client *api.Client, jobID string, s flowStep, masked []string) (env, all, missing []string, err error) {
	var why []string
	all = slices.Clone(masked) // legacy steps share masked in parallel
	names := s.Secrets
	if c := s.credential(); c != "" && !slices.Contains(names, c) {
		names = append(slices.Clone(names), c)
	}
	for _, name := range names {
		v, err := client.JobSecret(ctx, jobID, name)
		if err != nil {
			missing = append(missing, name)
			why = append(why, "missing secret "+name+": save it in Keystore")
			continue
		}
		env = append(env, name+"="+string(v))
		all = append(all, string(v))
	}
	if len(missing) > 0 {
		return nil, nil, missing, errors.New(strings.Join(why, "\n"))
	}
	return env, all, nil, nil
}

// execStep runs step s in dir with env (env[0] is PATH), its output masked of every value in masked, into out; with
// marker it first logs the command as [command]<line>. A cancelled step gets SIGTERM, then SIGKILL 10 s later.
func execStep(ctx context.Context, client *api.Client, dir string, env, masked []string, s flowStep, out io.Writer, marker bool) error {
	if kind, _ := s.target(); kind != "" {
		tmp, err := os.MkdirTemp("", "cinder-deploy-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmp)
		var extra, hidden []string
		s.Run, extra, hidden, err = targetScript(ctx, s, env, tmp)
		if err != nil {
			return err
		}
		env, masked = slices.Concat(env, extra), slices.Concat(masked, hidden)
	}
	tctx, stopTimer := context.WithTimeout(ctx, stepTimeout)
	defer stopTimer()
	m := mask.New(out)
	defer m.Close() // writes to a bytes.Buffer or a stepLog, neither of which fails
	for _, v := range masked {
		_ = m.Add(v) // lazy: values under 8 characters are refused and stay visible; too short to be a real secret
	}
	if marker {
		_, _ = fmt.Fprintf(m, "[command]%s\n", strings.ReplaceAll(strings.TrimRight(s.Run, "\n"), "\n", "\n[command]"))
	}
	cmd := exec.CommandContext(tctx, "sh", "-c", s.Run)
	cmd.Dir = dir
	// Stop the whole process group on cancel; WaitDelay SIGKILLs a step still running 10 s later and stops a stray child
	// holding the output pipe from hanging us.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = 10 * time.Second
	cmd.Env = env
	for _, tool := range slices.Sorted(maps.Keys(s.Setup)) {
		bin, err := setupTool(tctx, client, m, tool, s.Setup[tool])
		if err != nil {
			return err
		}
		if bin != "" {
			cmd.Env[0] = "PATH=" + bin + string(os.PathListSeparator) + strings.TrimPrefix(cmd.Env[0], "PATH=")
		}
	}
	// The pipe drains into a queue that m posts from, so slow log posts never hold the pipe past WaitDelay.
	queue := make(chan []byte, 4096) // up to 4096 reads of 32 KiB before the step waits on the log
	sent := make(chan struct{})
	go func() {
		for p := range queue {
			_, _ = m.Write(p)
		}
		close(sent)
	}()
	cmd.Stdout, cmd.Stderr = queueWriter(queue), queueWriter(queue)
	err := cmd.Run()
	close(queue)
	<-sent
	if tctx.Err() != nil && cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // whatever of the group outlived SIGTERM; ESRCH when nothing did
	}
	if tctx.Err() == context.DeadlineExceeded && ctx.Err() == nil {
		return fmt.Errorf("step %s timed out after %s and was stopped", s.Name, stepTimeout)
	}
	return err
}

// queueWriter hands each write, copied, to its channel.
type queueWriter chan []byte

func (q queueWriter) Write(p []byte) (int, error) {
	q <- bytes.Clone(p)
	return len(p), nil
}

const (
	flushLines = 200
	flushEvery = 500 * time.Millisecond
)

// annotationLine matches an ##[error] or ##[warning] line, with optional file=…,line=… inside the brackets.
var annotationLine = regexp.MustCompile(`^##\[(error|warning)(?: file=([^,\]]+)(?:,line=(\d+))?)?\](.*)$`)

// stepLog streams one step's output to the Worker in numbered batches of whole lines, each stamped when it was read,
// flushed at 200 lines and every 500 ms. Its ##[error] and ##[warning] lines are also sent as annotations on close.
type stepLog struct {
	ctx    context.Context
	client *api.Client
	job    string
	idx    int
	step   string
	stop   chan struct{}

	mu    sync.Mutex
	part  []byte
	batch []api.LogLine
	seq   int // the last batch the Worker took
	n     int // lines so far: the next line's number in the step
	notes []api.Annotation
	err   error // the first post that failed
}

func newStepLog(ctx context.Context, client *api.Client, job string, idx int, step string) *stepLog {
	l := &stepLog{ctx: ctx, client: client, job: job, idx: idx, step: step, stop: make(chan struct{})}
	go func() {
		t := time.NewTicker(flushEvery)
		defer t.Stop()
		for {
			select {
			case <-l.stop:
				return
			case <-t.C:
				l.mu.Lock()
				l.flush()
				l.mu.Unlock()
			}
		}
	}()
	return l
}

// Write never fails, so a log post that does never stops the step; close returns it.
func (l *stepLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.part = append(l.part, p...)
	for {
		i := bytes.IndexByte(l.part, '\n')
		if i < 0 {
			return len(p), nil
		}
		l.line(string(l.part[:i]))
		l.part = l.part[i+1:]
	}
}

func (l *stepLog) line(text string) {
	if m := annotationLine.FindStringSubmatch(text); m != nil {
		fileLine, _ := strconv.Atoi(m[3]) // 0, so left out, when the line gives none
		l.notes = append(l.notes, api.Annotation{Step: l.step, Level: m[1], Message: m[4], File: m[2], FileLine: fileLine, Line: l.n})
	}
	l.batch = append(l.batch, api.LogLine{At: time.Now().UTC().Format(time.RFC3339Nano), Text: text})
	l.n++
	if len(l.batch) >= flushLines {
		l.flush()
	}
}

// flush posts the batch as the next seq; on a 409 it resends it as the seq the Worker expects.
func (l *stepLog) flush() {
	if len(l.batch) == 0 {
		return
	}
	for try := 0; ; try++ {
		err := l.client.StepLog(l.ctx, l.job, l.idx, l.seq+1, l.batch)
		var conflict api.SeqConflict
		if errors.As(err, &conflict) && try < 3 {
			l.seq = conflict.Expected - 1
			continue
		}
		if err == nil {
			l.seq++
		} else if l.err == nil {
			l.err = err
		}
		break
	}
	l.batch = nil
}

// close logs a partial last line and each line of tail, sends what is left and the step's annotations.
func (l *stepLog) close(tail string) error {
	close(l.stop)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.part) > 0 {
		l.line(string(l.part))
		l.part = nil
	}
	for t := range strings.Lines(tail) {
		l.line(strings.TrimSuffix(t, "\n"))
	}
	l.flush()
	if len(l.notes) > 0 {
		if err := l.client.Annotations(l.ctx, l.job, l.notes); err != nil && l.err == nil {
			l.err = err
		}
	}
	return l.err
}
