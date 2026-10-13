package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/loop"
)

// jobCall is one post the fake Worker took for a flow job of a run: a step status, a log batch or annotations.
type jobCall struct {
	Kind, Status string
	Idx, Seq     int
	Code         *int
	Lines        []api.LogLine
	Notes        []api.Annotation
	Suite        map[string]any
}

// fakeRun steers the fake Worker: conflict answers a log batch with 409 expected_seq when it returns > 0, and
// cancel answers a heartbeat with cancel when it returns true. Both see the calls so far.
type fakeRun struct {
	conflict   func(idx, seq int) int
	cancel     func(calls []jobCall) bool
	secrets    map[string]string // the Keystore values the job may read
	legacy     bool              // a flow with no jobs: its payload has no run_id
	jobSecrets []string          // the payload's secrets: Keystore names every step gets
	logDelay   time.Duration     // how long the Worker takes to answer each log batch
}

// runRunJob runs a flow job of a run (a payload with run_id) through the real claim loop against a fake Worker, and
// returns the job's report and every status, log batch and annotation post the Worker took, in order.
func runRunJob(t *testing.T, steps []map[string]any, f fakeRun) (api.Report, []jobCall) {
	t.Helper()
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c"}} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	sha, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	p := map[string]any{"run_id": "run1", "key": "build/build", "sha": strings.TrimSpace(string(sha)), "steps": steps}
	if f.legacy {
		delete(p, "run_id")
	}
	if f.jobSecrets != nil {
		p["secrets"] = f.jobSecrets
	}
	payload, _ := json.Marshal(p)
	now := time.Now().UTC().Format(time.RFC3339)
	claim, _ := json.Marshal(map[string]any{"job": map[string]any{"id": "j1", "repo_id": "r1", "kind": "flow", "change_id": nil, "status": "claimed",
		"runner_id": "run1", "lease_expires_at": now, "created_at": now}, "payload": json.RawMessage(payload), "target_remote": repo})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var mu sync.Mutex
	var calls []jobCall
	var report api.Report
	claimed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/log") {
			time.Sleep(f.logDelay)
		}
		mu.Lock()
		defer mu.Unlock()
		parts := strings.Split(r.URL.Path, "/") // /api/work/jobs/j1/steps/<idx>/<what>
		switch {
		case r.URL.Path == "/api/work/claim":
			if claimed {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			claimed = true
			_, _ = w.Write(claim)
		case r.URL.Path == "/api/work/jobs/j1/heartbeat":
			_, _ = fmt.Fprintf(w, `{"cancel":%t}`, f.cancel != nil && f.cancel(calls))
		case len(parts) == 8 && parts[7] == "status":
			var b struct {
				Status string
				Code   *int `json:"exit_code"`
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			idx, _ := strconv.Atoi(parts[6])
			calls = append(calls, jobCall{Kind: "status", Idx: idx, Status: b.Status, Code: b.Code})
			w.WriteHeader(http.StatusNoContent)
		case len(parts) == 8 && parts[7] == "log":
			var b struct {
				Seq   int
				Lines []api.LogLine
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			idx, _ := strconv.Atoi(parts[6])
			if f.conflict != nil {
				if want := f.conflict(idx, b.Seq); want > 0 {
					w.WriteHeader(http.StatusConflict)
					_, _ = fmt.Fprintf(w, `{"error":{"code":"out_of_order","message":"expected seq %d"},"expected_seq":%d}`, want, want)
					return
				}
			}
			calls = append(calls, jobCall{Kind: "log", Idx: idx, Seq: b.Seq, Lines: b.Lines})
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/api/work/jobs/j1/annotations":
			var notes []api.Annotation
			_ = json.NewDecoder(r.Body).Decode(&notes)
			calls = append(calls, jobCall{Kind: "annotations", Notes: notes})
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/api/work/jobs/j1/tests":
			var suite map[string]any
			_ = json.NewDecoder(r.Body).Decode(&suite)
			calls = append(calls, jobCall{Kind: "tests", Suite: suite})
			w.WriteHeader(http.StatusNoContent)
		case len(parts) == 7 && parts[5] == "secrets" && f.secrets[parts[6]] != "":
			_ = json.NewEncoder(w).Encode(map[string]string{"value": f.secrets[parts[6]]})
		case r.URL.Path == "/api/work/jobs/j1/steps":
			var b struct{ Status string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			calls = append(calls, jobCall{Kind: "step", Status: b.Status})
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/api/work/jobs/j1/report":
			_ = json.NewDecoder(r.Body).Decode(&report)
			cancel()
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client := &api.Client{BaseURL: srv.URL, Token: "t"}
	if err := (&loop.Runner{Client: client, Slots: 1, Heartbeat: 50 * time.Millisecond, Backoff: 10 * time.Millisecond, Exec: dispatch(client)}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	return report, calls
}

// statuses lists the status posts as "idx status[ exit code]".
func statuses(calls []jobCall) []string {
	var out []string
	for _, c := range calls {
		if c.Kind == "status" {
			s := fmt.Sprintf("%d %s", c.Idx, c.Status)
			if c.Code != nil {
				s += fmt.Sprintf(" %d", *c.Code)
			}
			out = append(out, s)
		}
	}
	return out
}

// batches returns step idx's log batches in the order the Worker took them.
func batches(calls []jobCall, idx int) []jobCall {
	return slices.DeleteFunc(slices.Clone(calls), func(c jobCall) bool { return c.Kind != "log" || c.Idx != idx })
}

// texts is every line of step idx's log, in order.
func texts(calls []jobCall, idx int) (out []string) {
	for _, b := range batches(calls, idx) {
		for _, l := range b.Lines {
			out = append(out, l.Text)
		}
	}
	return out
}

func TestFlowJob_StepsRunInOrder_FailedStepSkipsRest(t *testing.T) {
	report, calls := runRunJob(t, []map[string]any{
		{"name": "build", "run": "touch built"},
		{"name": "test", "run": "test -f built && exit 3"},
		{"name": "ship", "run": "true"},
	}, fakeRun{})
	if want := []string{"3 running", "3 passed", "5 running", "5 passed", "0 running", "0 passed 0", "1 running", "1 failed 3", "2 skipped", "4 running", "4 passed"}; !slices.Equal(statuses(calls), want) {
		t.Errorf("statuses = %v, want %v", statuses(calls), want)
	}
	if report.Status != "failed" || len(batches(calls, 2)) != 0 {
		t.Errorf("report = %+v, ship logged %v; want failed with ship never run", report, batches(calls, 2))
	}
}

func TestFlowJob_ReportsSetUpAndCompleteSteps(t *testing.T) {
	report, calls := runRunJob(t, []map[string]any{{"name": "build", "run": "true"}}, fakeRun{})
	if want := []string{"1 running", "1 passed", "3 running", "3 passed", "0 running", "0 passed 0", "2 running", "2 passed"}; report.Status != "done" || !slices.Equal(statuses(calls), want) {
		t.Fatalf("report %+v, statuses = %v; want Set up job (1) and Checkout (3) before build and Complete job (2) after it, %v", report, statuses(calls), want)
	}
	setup := strings.Join(texts(calls, 1), "\n")
	for _, want := range []string{"Runner name: 'run1'", "Operating system: ", "Prepared workflow directory ", "Complete job name: build/build"} {
		if !strings.Contains(setup, want) {
			t.Errorf("Set up job log %q: want %q", setup, want)
		}
	}
	if done := texts(calls, 2); len(done) != 2 || !strings.HasPrefix(done[0], "Removed workspace ") || !strings.HasPrefix(done[1], "Steps took ") {
		t.Errorf("Complete job log %q: want the workspace removed and how long the steps took", done)
	}
}

func TestSetUpStep_ListsSecretNamesNeverValues(t *testing.T) {
	_, calls := runRunJob(t, []map[string]any{{"name": "build", "run": "true"}}, fakeRun{jobSecrets: []string{"DATABASE_URL", "STRIPE_WEBHOOK_SECRET"},
		secrets: map[string]string{"DATABASE_URL": "postgres://db-secret-value", "STRIPE_WEBHOOK_SECRET": "whsec-secret-value"}})
	setup := strings.Join(texts(calls, 1), "\n")
	if !strings.Contains(setup, "Secret source: Keystore · injected 2 (DATABASE_URL, STRIPE_WEBHOOK_SECRET)") || strings.Contains(setup, "secret-value") {
		t.Fatalf("Set up job log %q: want both secret names and neither value", setup)
	}
}

func TestFlowJob_LogBatches_FlushAt200LinesOr500ms(t *testing.T) {
	_, calls := runRunJob(t, []map[string]any{
		{"name": "burst", "run": "seq 1 449"},
		{"name": "slow", "run": "echo a; sleep 1.2; echo b"},
	}, fakeRun{})
	var sizes, seqs []int
	for _, b := range batches(calls, 0) {
		sizes, seqs = append(sizes, len(b.Lines)), append(seqs, b.Seq)
		for _, l := range b.Lines {
			if _, err := time.Parse(time.RFC3339Nano, l.At); err != nil || strings.Contains(l.Text, "\n") {
				t.Errorf("line %+v: want a timestamp and one whole line", l)
			}
		}
	}
	// The [command] line and 449 numbers: two full batches of 200, then the rest when the step ends.
	if !slices.Equal(sizes, []int{200, 200, 50}) || !slices.Equal(seqs, []int{1, 2, 3}) {
		t.Errorf("burst batches: sizes %v seqs %v, want [200 200 50] [1 2 3]", sizes, seqs)
	}
	if got := texts(calls, 0); len(got) != 450 || got[1] != "1" || got[449] != "449" {
		t.Errorf("burst lines: %d, want 450 in order", len(got))
	}
	slow := batches(calls, 1)
	if len(slow) < 2 || slow[0].Seq != 1 || !slices.ContainsFunc(slow[0].Lines, func(l api.LogLine) bool { return l.Text == "a" }) ||
		slices.ContainsFunc(slow[0].Lines, func(l api.LogLine) bool { return l.Text == "b" }) {
		t.Errorf("slow batches %+v: want seq 1 holding a, flushed by the timer before b was printed", slow)
	}
}

func TestFlowJob_LogConflict_ResendsFromExpectedSeq(t *testing.T) {
	report, calls := runRunJob(t, []map[string]any{{"name": "build", "run": "echo hi"}}, fakeRun{
		// The Worker already holds two batches of this step (say from an earlier attempt), so it expects seq 3.
		conflict: func(idx, seq int) int {
			if seq < 3 {
				return 3
			}
			return 0
		},
	})
	b := batches(calls, 0)
	if report.Status != "done" || len(b) != 1 || b[0].Seq != 3 || !slices.Equal(texts(calls, 0), []string{"[command]echo hi", "hi"}) {
		t.Errorf("report %+v, batches %+v; want the batch resent whole as seq 3", report, b)
	}
}

func TestFlowJob_ErrorCommand_SentAsAnnotationAndKeptInLog(t *testing.T) {
	_, calls := runRunJob(t, []map[string]any{{"name": "lint", "run": `echo '##[group]Lint'; echo '##[error file=app.js,line=3]boom'; echo '##[warning]careful'; echo '##[endgroup]'`}}, fakeRun{})
	got := texts(calls, 0)
	if want := []string{"##[group]Lint", "##[error file=app.js,line=3]boom", "##[warning]careful", "##[endgroup]"}; len(got) != 5 || !slices.Equal(got[1:], want) {
		t.Errorf("log = %q, want the command then %q", got, want)
	}
	var notes []api.Annotation
	for _, c := range calls {
		notes = append(notes, c.Notes...)
	}
	want := []api.Annotation{
		{Step: "lint", Level: "error", Message: "boom", File: "app.js", FileLine: 3, Line: 2},
		{Step: "lint", Level: "warning", Message: "careful", Line: 3},
	}
	if !slices.Equal(notes, want) {
		t.Errorf("annotations = %+v, want %+v", notes, want)
	}
}

func TestFlowJob_CommandLine_LoggedWithCommandMarker(t *testing.T) {
	_, calls := runRunJob(t, []map[string]any{{"name": "build", "run": "echo built"}}, fakeRun{})
	if got := texts(calls, 0); !slices.Equal(got, []string{"[command]echo built", "built"}) {
		t.Errorf("log = %q, want the command line marked, then its output", got)
	}
}

func TestFlowJob_Cancel_StopsRunningStepAndReportsCancelled(t *testing.T) {
	report, calls := runRunJob(t, []map[string]any{
		{"name": "serve", "run": `trap 'echo stopping; exit 143' TERM; echo started; while :; do sleep 0.05; done`},
		{"name": "after", "run": "true"},
	}, fakeRun{cancel: func(calls []jobCall) bool { return slices.Contains(texts(calls, 0), "started") }})
	if want := []string{"2 running", "2 passed", "4 running", "4 passed", "0 running", "0 cancelled 143", "1 skipped", "3 running", "3 passed"}; !slices.Equal(statuses(calls), want) {
		t.Errorf("statuses = %v, want %v", statuses(calls), want)
	}
	// "stopping" is the step's TERM trap: it was asked to stop, not killed outright.
	if report.Status != "cancelled" || !slices.Contains(texts(calls, 0), "stopping") {
		t.Errorf("report %+v, log %q; want cancelled after the step trapped SIGTERM", report, texts(calls, 0))
	}
}

func TestFlowJob_JunitStep_PostsParsedSuite(t *testing.T) {
	xml := `<testsuite><testcase classname="orders" name="TestCreate"/><testcase classname="orders" name="TestPatch"><failure/></testcase><testcase name="TestPage"><skipped/></testcase></testsuite>`
	report, calls := runRunJob(t, []map[string]any{
		{"name": "integration", "run": "printf '%s' '" + xml + "' > report.xml; exit 1", "needs": []string{}, "junit": "report.xml"},
	}, fakeRun{})
	if report.Status != "failed" {
		t.Fatalf("report %+v, want failed", report)
	}
	var suites []map[string]any
	for _, c := range calls {
		if c.Kind == "tests" {
			suites = append(suites, c.Suite)
		}
	}
	want := []map[string]any{{"suite": "report.xml", "passed": 1.0, "failed": 1.0, "skipped": 1.0, "failures": []any{"orders.TestPatch"}}}
	if fmt.Sprint(suites) != fmt.Sprint(want) {
		t.Fatalf("suites %v, want %v", suites, want)
	}
}

func TestDeployStep_SSH_RunsCommandWithKeyAndStreamsOutput(t *testing.T) {
	// A fake ssh prints its target and command and whether -i points at the key from Keystore; ssh-keyscan answers
	// the host key the step's fingerprint pins.
	fakeBin(t, map[string]string{
		"ssh-keyscan": "echo 'web1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'\n",
		"ssh":         "echo \"ssh ${10} ${11}\"\ngrep -qx key-body-from-keystore \"$2\" && echo key from keystore\n",
	})
	key := "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-body-from-keystore\n-----END OPENSSH PRIVATE KEY-----"
	report, calls := runRunJob(t, []map[string]any{{"name": "ship", "deploy": "production", "target": "Bring your own (SSH)",
		"ssh": map[string]any{"host": "web1.example.com", "user": "deploy", "command": "systemctl restart app", "fingerprint": "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU", "key_secret": "SSH_KEY"}}},
		fakeRun{secrets: map[string]string{"SSH_KEY": key}})
	if report.Status != "done" {
		t.Fatalf("report = %+v, want done", report)
	}
	got := texts(calls, 0)
	if !slices.Contains(got, "ssh deploy@web1.example.com systemctl restart app") {
		t.Errorf("log = %q, want ssh run with user@host and the command", got)
	}
	if !slices.Contains(got, "key from keystore") {
		t.Errorf("log = %q, want ssh given the Keystore key with -i", got)
	}
	if !slices.Equal(statuses(calls), []string{"1 running", "1 passed", "3 running", "3 passed", "0 running", "0 passed 0", "2 running", "2 passed"}) {
		t.Errorf("statuses = %v", statuses(calls))
	}
}

func TestDeployStep_AWSMissingCLI_FailsWithMessage(t *testing.T) {
	// PATH holds only what the job needs besides aws, so an aws installed on this machine doesn't hide the failure.
	bin := t.TempDir()
	for _, tool := range []string{"git", "sh"} {
		p, err := exec.LookPath(tool)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(p, filepath.Join(bin, tool)); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	report, calls := runRunJob(t, []map[string]any{{"name": "ship", "deploy": "production", "target": "AWS", "run": "aws ecs update-service --cluster c --service s",
		"aws": map[string]any{"secret": "AWS_ROLE", "region": "us-east-1", "service": "ecs", "resource": "c/s"}}},
		fakeRun{secrets: map[string]string{"AWS_ROLE": "[default]\nrole_arn = arn:aws:iam::1:role/deploy"}})
	if report.Status != "failed" {
		t.Fatalf("report = %+v, want failed", report)
	}
	if got := texts(calls, 0); !slices.Contains(got, "aws CLI not found on this worker's PATH: install it to run this deploy step") {
		t.Errorf("log = %q, want the missing CLI named", got)
	}
	if !slices.Equal(statuses(calls), []string{"1 running", "1 passed", "3 running", "3 passed", "0 running", "0 failed 127", "2 running", "2 passed"}) {
		t.Errorf("statuses = %v", statuses(calls))
	}
}
