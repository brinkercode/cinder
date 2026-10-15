package main

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/loop"
)

// Missing is the report's missing_secrets joined by commas, so a stepReport stays comparable.
type stepReport struct{ Name, Status, Logs, Missing string }

// runFlowJob checks out a one-commit repo and hands a flow job with steps (and more payload, such as env) to the real
// claim loop through a fake Worker; it returns the job's report and every step report in the order the Worker got them.
// The fake Worker passes every step it is asked to drive and serves every secret as flow-s3cr3t-value.
func runFlowJob(t *testing.T, steps []map[string]any, more map[string]any) (api.Report, []stepReport) {
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
	p := map[string]any{"flow": "ci", "sha": strings.TrimSpace(string(sha)), "steps": steps}
	maps.Copy(p, more)
	payload, _ := json.Marshal(p)
	now := time.Now().UTC().Format(time.RFC3339)
	claim, _ := json.Marshal(map[string]any{"job": map[string]any{"id": "j1", "repo_id": "r1", "kind": "flow", "change_id": nil, "status": "claimed",
		"runner_id": "run1", "lease_expires_at": now, "created_at": now}, "payload": json.RawMessage(payload), "target_remote": repo})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var mu sync.Mutex
	var reports []stepReport
	var report api.Report
	claimed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch path := r.URL.Path; {
		case strings.HasPrefix(path, "/api/work/jobs/j1/steps/") && strings.HasSuffix(path, "/start"):
			reports = append(reports, stepReport{Name: strings.Split(path, "/")[6], Status: "driven"})
			_, _ = w.Write([]byte(`{"status":"passed","logs":"wf · sync Synced"}`))
		case strings.HasSuffix(path, "/secrets/UNSAVED"):
			http.Error(w, `{"error":{"code":"not_found","message":"no secret UNSAVED for this job"}}`, http.StatusNotFound)
		case strings.HasPrefix(path, "/api/work/jobs/j1/secrets/"):
			_, _ = w.Write([]byte(`{"value":"flow-s3cr3t-value"}`))
		case path == "/api/work/claim":
			if claimed {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			claimed = true
			_, _ = w.Write(claim)
		case path == "/api/work/jobs/j1/steps":
			var b struct {
				stepReport
				MissingSecrets []string `json:"missing_secrets"`
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			b.Missing = strings.Join(b.MissingSecrets, ",")
			reports = append(reports, b.stepReport)
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(path, "/log") || path == "/api/work/jobs/j1/annotations":
			w.WriteHeader(http.StatusNoContent)
		case path == "/api/work/jobs/j1/report":
			_ = json.NewDecoder(r.Body).Decode(&report)
			cancel()
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client := &api.Client{BaseURL: srv.URL, Token: "t"}
	if err := (&loop.Runner{Client: client, Slots: 1, Backoff: 10 * time.Millisecond, Exec: dispatch(client)}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	return report, reports
}

// lint and unit each wait for the other to start, so the run only finishes when the parallel pair really runs in parallel.
func TestFlow_ThreeStepsWithParallelPair_RunsToDoneWithPerStepStatus(t *testing.T) {
	report, reports := runFlowJob(t, []map[string]any{
		{"name": "build", "stage": "build", "run": "touch built", "needs": []string{}},
		{"name": "lint", "stage": "test", "run": "test -f built && touch lint.started && until [ -f unit.started ]; do sleep 0.01; done", "needs": []string{"build"}},
		{"name": "unit", "stage": "test", "run": "test -f built && touch unit.started && until [ -f lint.started ]; do sleep 0.01; done", "needs": []string{"build"}},
	}, nil)
	var steps []string // "name status" in the order the Worker got them
	for _, r := range reports {
		steps = append(steps, r.Name+" "+r.Status)
	}
	if report.Status != "done" {
		t.Fatalf("report = %+v, want done; steps %v", report, steps)
	}
	for _, s := range []string{"build", "lint", "unit"} {
		if !slices.Contains(steps, s+" running") || !slices.Contains(steps, s+" passed") {
			t.Errorf("step %s: got %v, want running then passed", s, steps)
		}
	}
	if built := slices.Index(steps, "build passed"); built > slices.Index(steps, "lint running") || built > slices.Index(steps, "unit running") {
		t.Errorf("lint and unit started before build passed: %v", steps)
	}
}

func TestFlow_StepEchoingFlowSecret_ReportsMaskedLog(t *testing.T) {
	report, reports := runFlowJob(t, []map[string]any{
		{"name": "leak", "stage": "build", "run": `echo "token=$DEPLOY_KEY"; echo "$DEPLOY_KEY" >&2`, "needs": []string{}},
	}, map[string]any{"env": map[string]string{"DEPLOY_KEY": "flow-s3cr3t-value"}})
	if report.Status != "done" {
		t.Fatalf("report = %+v, want done; steps %v", report, reports)
	}
	last := reports[len(reports)-1]
	if last.Status != "passed" || last.Logs != "token=***\n***\n" {
		t.Fatalf("got %+v, want passed with masked logs", last)
	}
}

// The Worker drives a deploy step (cinder-pipeline's syncEnvironment); the runner hands it over and its dependant runs.
func TestFlow_DeployStep_IsDrivenByWorkerNotFailedOnRunner(t *testing.T) {
	report, reports := runFlowJob(t, []map[string]any{
		{"name": "ship", "stage": "deploy", "deploy": "production", "needs": []string{}},
		{"name": "smoke", "stage": "verify", "run": "true", "needs": []string{"ship"}},
	}, nil)
	for _, r := range reports {
		if strings.Contains(r.Logs, "don't run on runners yet") {
			t.Fatalf("deploy step failed on the runner: %+v", r)
		}
	}
	if report.Status != "done" || reports[0] != (stepReport{Name: "ship", Status: "driven"}) {
		t.Fatalf("report = %+v, steps %+v; want done with ship driven by the Worker", report, reports)
	}
}

// Flow secrets are read from the keystore for the job, not from env, and masked out of the step's log.
func TestFlow_FlowSecret_ReadFromKeystoreAndMasked(t *testing.T) {
	report, reports := runFlowJob(t, []map[string]any{
		{"name": "aws", "stage": "deploy", "run": `echo "key=$AWS_SECRET_ACCESS_KEY"`, "needs": []string{}},
	}, map[string]any{"secrets": []string{"AWS_SECRET_ACCESS_KEY"}})
	if last := reports[len(reports)-1]; report.Status != "done" || last.Status != "passed" || last.Logs != "key=***\n" {
		t.Fatalf("report = %+v, steps %+v; want passed with the secret set and masked", report, reports)
	}
}

// A secret nobody saved failed the run before any step started, and every step showed queued with no reason.
func TestFlow_UnsavedSecret_EveryStepFailsWithTheReason(t *testing.T) {
	report, reports := runFlowJob(t, []map[string]any{
		{"name": "test", "stage": "build", "run": "true", "needs": []string{}},
		{"name": "image", "stage": "build", "run": "true", "needs": []string{"test"}},
	}, map[string]any{"secrets": []string{"UNSAVED"}})
	if report.Status != "failed" || len(reports) != 2 {
		t.Fatalf("report = %+v, steps %+v; want failed with both steps reported", report, reports)
	}
	for _, r := range reports {
		if r.Status != "failed" || !strings.Contains(r.Logs, "secret UNSAVED") || !strings.Contains(r.Logs, "no secret UNSAVED for this job") {
			t.Errorf("step %+v, want failed naming the secret and why", r)
		}
	}
}

// infra-cloudflare-tf's deploy: the AWS stage lacks its credentials, the Cloudflare plan beside it still runs.
func TestFlow_StepSecretMissing_FailsThatStepOnly(t *testing.T) {
	report, reports := runFlowJob(t, []map[string]any{
		{"name": "aws", "stage": "deploy", "run": "true", "secrets": []string{"AWS_KEY", "UNSAVED"}, "needs": []string{}},
		{"name": "cf", "stage": "deploy", "run": `echo "key=$CF_TOKEN"`, "secrets": []string{"CF_TOKEN"}, "needs": []string{}},
	}, nil)
	got := map[string]stepReport{}
	for _, r := range reports {
		got[r.Name] = r
	}
	if want := (stepReport{Name: "aws", Status: "failed", Logs: "missing secret UNSAVED: save it in Keystore\n", Missing: "UNSAVED"}); got["aws"] != want {
		t.Errorf("aws = %+v, want %+v", got["aws"], want)
	}
	if want := (stepReport{Name: "cf", Status: "passed", Logs: "key=***\n"}); got["cf"] != want {
		t.Errorf("cf = %+v, want %+v", got["cf"], want)
	}
	if report.Status != "failed" {
		t.Errorf("report = %+v, want failed", report)
	}
}

func TestFlow_StepSecretMissing_SkipsItsDependents(t *testing.T) {
	_, reports := runFlowJob(t, []map[string]any{
		{"name": "aws", "stage": "deploy", "run": "true", "secrets": []string{"UNSAVED"}, "needs": []string{}},
		{"name": "smoke", "stage": "verify", "run": "true", "needs": []string{"aws"}},
		{"name": "lint", "stage": "build", "run": "true", "needs": []string{}},
	}, nil)
	var steps []string
	for _, r := range reports {
		steps = append(steps, r.Name+" "+r.Status)
	}
	slices.Sort(steps)
	if want := []string{"aws failed", "lint passed", "lint running", "smoke skipped"}; !slices.Equal(steps, want) {
		t.Errorf("steps = %v, want %v", steps, want)
	}
}

// A matrix × shard leg's steps see its matrix values and shard in env, so each leg runs its own slice.
func TestFlow_MatrixLeg_ReceivesItsSlice(t *testing.T) {
	report, reports := runFlowJob(t, []map[string]any{
		{"name": "test", "run": `echo "$CINDER_LEG|$CINDER_MATRIX_NODE_VERSION|$CINDER_MATRIX_OS|$CINDER_SHARD_INDEX/$CINDER_SHARD_COUNT"`},
	}, map[string]any{"leg": "node-version 20, os linux, 2/3"})
	if last := reports[len(reports)-1]; report.Status != "done" || last.Logs != "node-version 20, os linux, 2/3|20|linux|2/3\n" {
		t.Fatalf("report %+v, step %+v", report, last)
	}
}

func TestFlow_StepOverTimeout_FailsWithTimedOutAndFreesTheWorker(t *testing.T) {
	stepTimeout = 300 * time.Millisecond
	t.Cleanup(func() { stepTimeout = 30 * time.Minute })
	report, reports := runFlowJob(t, []map[string]any{{"name": "hang", "stage": "build", "run": "sleep 60", "needs": []string{}}}, nil)
	last := reports[len(reports)-1]
	if report.Status != "failed" || last.Status != "failed" || !strings.Contains(last.Logs, "timed out after 300ms") {
		t.Fatalf("report = %+v, last step %+v, want failed with a timed-out message", report, last)
	}
}

func TestFlow_HungCheckout_FailsWithTimedOutBeforeAnyStep(t *testing.T) {
	gitTimeout = 300 * time.Millisecond
	t.Cleanup(func() { gitTimeout = 5 * time.Minute })
	bin := t.TempDir()
	real, _ := exec.LookPath("git")
	script := "#!/bin/sh\ncase \"$*\" in *clone*) exec sleep 60;; esac\nexec " + real + " \"$@\"\n" // only the checkout hangs
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	report, _ := runFlowJob(t, []map[string]any{{"name": "a", "stage": "build", "run": "true", "needs": []string{}}}, nil)
	if report.Status != "failed" || !strings.Contains(report.Detail, "timed out after 300ms") {
		t.Fatalf("report = %+v, want failed with a timed-out message", report)
	}
}

func TestFlow_Job_EmitsSetUpCheckoutAndCompleteSteps(t *testing.T) {
	report, calls := runRunJob(t, []map[string]any{{"name": "build", "run": "true"}}, fakeRun{})
	// Set up job (1), Checkout (3), build, Complete job (2).
	if want := []string{"1 running", "1 passed", "3 running", "3 passed", "0 running", "0 passed 0", "2 running", "2 passed"}; report.Status != "done" || !slices.Equal(statuses(calls), want) {
		t.Fatalf("report %+v, statuses = %v; want %v", report, statuses(calls), want)
	}
	checkout := strings.Join(texts(calls, 3), "\n")
	for _, want := range []string{"Repository: ", "Commit: ", "Depth: full history", "Fetched in "} {
		if !strings.Contains(checkout, want) {
			t.Errorf("Checkout log %q: want %q", checkout, want)
		}
	}
}

func TestFlow_FailedStep_StillRunsPostSteps(t *testing.T) {
	report, calls := runRunJob(t, []map[string]any{
		{"name": "test", "run": "printf '<testsuite/>' > report.xml; exit 1", "junit": "report.xml"},
		{"name": "ship", "run": "true"},
	}, fakeRun{})
	// Set up job (2), Checkout (4), test fails, ship skipped, then Upload artifacts (5) and Complete job (3).
	want := []string{"2 running", "2 passed", "4 running", "4 passed", "0 running", "0 failed 1", "1 skipped", "5 running", "5 passed", "3 running", "3 passed"}
	if report.Status != "failed" || !slices.Equal(statuses(calls), want) {
		t.Fatalf("report %+v, statuses = %v; want %v", report, statuses(calls), want)
	}
	if got := texts(calls, 5); !slices.Equal(got, []string{"Sent test report report.xml of step test"}) {
		t.Errorf("Upload artifacts log = %q, want the failed step's report sent", got)
	}
}

func TestFlow_SetUpJob_MasksSecretValues(t *testing.T) {
	_, calls := runRunJob(t, []map[string]any{{"name": "build", "run": "true"}}, fakeRun{jobSecrets: []string{"DATABASE_URL"},
		secrets: map[string]string{"DATABASE_URL": "postgres://db-secret-value"}})
	setup := texts(calls, 1)
	at := slices.Index(setup, "##[group]Environment")
	if at < 0 || !slices.Equal(setup[at:min(at+3, len(setup))], []string{"##[group]Environment", "DATABASE_URL=***", "##[endgroup]"}) {
		t.Fatalf("Set up job log %q: want a grouped environment with the secret shown as ***", setup)
	}
	if strings.Contains(strings.Join(setup, "\n"), "secret-value") {
		t.Fatalf("Set up job log %q: printed the secret's value", setup)
	}
}

func TestFlow_Step_GetsFreshHome_ResultsNeverReadThroughSymlinkOutOfTree(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	outside := filepath.Join(t.TempDir(), "secret.xml")
	if err := os.WriteFile(outside, []byte("<testsuite/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := `test "$HOME" = "$TMPDIR" && test "$HOME" != "` + os.Getenv("HOME") + `" && ln -s ` + outside + ` leak.xml`
	report, calls := runRunJob(t, []map[string]any{{"name": "test", "run": run, "junit": "leak.xml"}}, fakeRun{})
	if report.Status != "done" {
		t.Fatalf("report %+v, want the step to see a fresh HOME and TMPDIR", report)
	}
	if got := strings.Join(texts(calls, 4), "\n"); !strings.HasPrefix(got, "junit leak.xml: ") {
		t.Fatalf("Upload artifacts log = %q, want the symlink out of the tree refused", got)
	}
}
