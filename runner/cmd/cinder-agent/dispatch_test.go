package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/harness"
	"github.com/brinkercode/cinder/runner/internal/loop"
)

func TestRun_DevelopClaim_RunsDevelopHandlerAndReportsItsResult(t *testing.T) {
	fork := fakeFork(t, "#!/bin/sh\necho hello > hello.txt\necho '{\"is_error\":false,\"session_id\":\"sess-1\",\"result\":\"done\"}'\n")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	claimed, report := false, ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/work/jobs/d1/report":
			b, _ := io.ReadAll(r.Body)
			report = string(b)
			cancel()
		case r.URL.Path == "/api/work/claim" && !claimed:
			claimed = true
			fmt.Fprintf(w, `{"token":null,"read_token":null,"payload":{},"fork_remote":%q,"target_remote":%q,`+
				`"change":{"id":"c1","intent":"say hello","target_branch":"main"},"job":{"id":"d1","repo_id":"r1","kind":"develop",`+
				`"change_id":"c1","status":"claimed","runner_id":"a1","lease_expires_at":"2026-10-04T12:00:00Z","created_at":"2026-10-04T10:00:00Z"}}`, fork, fork)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	r := &loop.Runner{Client: &api.Client{BaseURL: srv.URL, Token: "api"}, Slots: 1, Heartbeat: time.Second, Backoff: 10 * time.Millisecond,
		Log: slog.New(slog.DiscardHandler), Exec: run}
	_ = r.Run(ctx)
	srv.Close()

	var rep api.Report
	var d developed
	if err := json.Unmarshal([]byte(report), &rep); err != nil || rep.Status != "done" || json.Unmarshal([]byte(rep.Detail), &d) != nil {
		t.Fatalf("report = %q, want done with the develop result", report)
	}
	if head := gitOut(t, fork, "rev-parse", "main"); d.Head != head || d.SessionID != "sess-1" {
		t.Fatalf("reported %+v, want head %s (fork main) and session sess-1", d, head)
	}
}

func TestRun_UnknownKind_ReportsFailedNamingTheKind(t *testing.T) {
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "j1", Kind: "index"}})
	if rep.Status != "failed" || !strings.Contains(rep.Detail, "index") {
		t.Fatalf("report = %+v, want failed naming index", rep)
	}
}

func TestRun_ContractConvergePayload_DecodesTheirsAsObjects(t *testing.T) {
	payload, err := os.ReadFile("../../../worker/src/api/fixtures/converge-payload.json")
	if err != nil {
		t.Fatal(err)
	}
	// No remotes, so converge itself fails at clone; only a payload decode error is the bug.
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "j1", Kind: "converge"}, Payload: payload})
	if strings.Contains(rep.Detail, "bad converge payload") {
		t.Fatalf("report = %+v, want the contract's converge payload decoded", rep)
	}
}

func TestRun_DevelopOnEmptyFork_ReportsFailedTargetHasNoCommits(t *testing.T) {
	fork := filepath.Join(t.TempDir(), "fork.git")
	gitOut(t, ".", "init", "--quiet", "--bare", fork)
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork,
		Change: &api.Change{ID: "c1", TargetBranch: "main"}})
	if rep.Status != "failed" || rep.Detail != "target main has no commits" {
		t.Fatalf("report = %+v, want failed with %q", rep, "target main has no commits")
	}
}

func TestRun_DevelopClaim_EgressAllowlistIsTheVersions(t *testing.T) {
	try := "curl -s -o /dev/null --max-time 5 -x \"$HTTPS_PROXY\" https://%s/ || true\n"
	fork := fakeFork(t, "#!/bin/sh\n"+fmt.Sprintf(try, "allowed.invalid")+fmt.Sprintf(try, "other.invalid")+
		"echo '{\"is_error\":false,\"result\":\"done\"}'\n")
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork,
		Change: &api.Change{ID: "c1", TargetBranch: "main"}, Agent: &api.Agent{Agent: "dev", Version: 3, Egress: []string{"allowed.invalid"}}})
	var d developed
	if rep.Status != "done" || json.Unmarshal([]byte(rep.Detail), &d) != nil {
		t.Fatalf("report = %+v, want done with the develop result", rep)
	}
	if fmt.Sprint(d.EgressBlocked) != "[other.invalid]" {
		t.Fatalf("egress blocked = %v, want only other.invalid (allowed.invalid is the version's egress)", d.EgressBlocked)
	}
}

func TestRun_DevelopClaim_ReportCarriesAllowedAndDeniedHostCounts(t *testing.T) {
	try := "curl -s -o /dev/null --max-time 5 -x \"$HTTPS_PROXY\" https://%s/ || true\n"
	fork := fakeFork(t, "#!/bin/sh\n"+fmt.Sprintf(try, "allowed.invalid")+fmt.Sprintf(try, "other.invalid")+fmt.Sprintf(try, "other.invalid")+
		"echo '{\"is_error\":false,\"result\":\"done\"}'\n")
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork,
		Change: &api.Change{ID: "c1", TargetBranch: "main"}, Agent: &api.Agent{Agent: "dev", Version: 3, Egress: []string{"allowed.invalid"}}})
	b, _ := json.Marshal(rep)
	var got struct {
		Egress api.Egress `json:"egress"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got.Egress.Allowed) != "map[allowed.invalid:1]" || fmt.Sprint(got.Egress.Denied) != "map[other.invalid:2]" {
		t.Fatalf("report egress = %+v, want allowed.invalid:1 allowed and other.invalid:2 denied", got.Egress)
	}
}

func TestRun_DevelopClaim_AuditMode_ReportsOffListHostAsWouldDeny(t *testing.T) {
	try := "curl -s -o /dev/null --max-time 5 -x \"$HTTPS_PROXY\" https://%s/ || true\n"
	fork := fakeFork(t, "#!/bin/sh\n"+fmt.Sprintf(try, "allowed.invalid")+fmt.Sprintf(try, "other.invalid")+
		"echo '{\"is_error\":false,\"result\":\"done\"}'\n")
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork, Change: &api.Change{ID: "c1", TargetBranch: "main"},
		Agent: &api.Agent{Agent: "dev", Version: 3, Egress: []string{"allowed.invalid"}, EgressMode: "audit"}})
	if rep.Egress == nil || fmt.Sprint(rep.Egress.WouldDeny) != "map[other.invalid:1]" || len(rep.Egress.Denied) != 0 {
		t.Fatalf("report = %+v, want other.invalid:1 would_deny and nothing denied", rep)
	}
}

// mergePayload is the Worker's merge payload landing fork's main, with the tree its verify checked.
func mergePayload(t *testing.T, fork string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"batch": []map[string]string{{"change_id": "c1", "remote": fork, "tree": gitOut(t, fork, "rev-parse", "main^{tree}")}}})
	return b
}

func TestRun_MergeClaim_CinderAgentVersionTrailerNamesTheVersion(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "change")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, work, "push", "--quiet", fork, "main")

	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "m1", Kind: "merge"}, TargetRemote: target, Payload: mergePayload(t, fork),
		Change: &api.Change{ID: "c1", TargetBranch: "main"}, Agent: &api.Agent{Agent: "dev", Version: 3}})
	if rep.Status != "done" {
		t.Fatalf("report = %+v, want done", rep)
	}
	if got := gitOut(t, target, "log", "-1", "--format=%(trailers:key=Cinder-Agent-Version,valueonly)", "main"); got != "dev@v3" {
		t.Fatalf("Cinder-Agent-Version = %q, want dev@v3", got)
	}
}

func TestRun_MergeClaim_ReportsTheMergedSHA(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "change")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, work, "push", "--quiet", fork, "main")
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "m2", Kind: "merge"}, TargetRemote: target, Payload: mergePayload(t, fork),
		Change: &api.Change{ID: "c1", TargetBranch: "main"}, Agent: &api.Agent{Agent: "dev", Version: 3}})
	if want := gitOut(t, target, "rev-parse", "main"); rep.Status != "done" || rep.MergedSHA != want {
		t.Fatalf("report = %+v, want done with merged_sha %s (the target's new head)", rep, want)
	}
}

func TestRun_MergeWithoutWorkerSigningKey_LandsUnsignedAndReportsUnsigned(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "change")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, work, "push", "--quiet", fork, "main")
	// The Worker without its MERGE_SIGNING_KEY binding answers the sign request with no signature.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/work/jobs/m1/sign" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"signature":null}`)
	}))
	defer srv.Close()
	client = &api.Client{BaseURL: srv.URL, Token: "rt"}
	defer func() { client = nil }()

	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "m1", Kind: "merge"}, TargetRemote: target, Payload: mergePayload(t, fork),
		Change: &api.Change{ID: "c1", TargetBranch: "main"}, Agent: &api.Agent{Agent: "dev", Version: 3}})
	if rep.Status != "done" || !rep.Unsigned {
		t.Fatalf("report = %+v, want done and unsigned", rep)
	}
	if got := gitOut(t, target, "log", "-1", "--format=%G?", "main"); got != "N" {
		t.Fatalf("signature status = %q, want N (unsigned)", got)
	}
}

// usageBody is the model-usage body reportUsage posts for s, r and runErr.
func usageBody(t *testing.T, s harness.Spec, r harness.Result, runErr error) string {
	var usage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		usage = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	client = &api.Client{BaseURL: srv.URL, Token: "rt"}
	defer func() { client = nil }()
	reportUsage(context.Background(), "d1", s, r, runErr)
	return strings.TrimSpace(usage)
}

func TestUsage_CfOpencodeModel_IsAccepted(t *testing.T) {
	got := usageBody(t, harness.Spec{Harness: "opencode", Model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"}, harness.Result{Tokens: 5}, nil)
	if want := `{"cost_usd":0,"job":"d1","provider":"cf","source":"credits","tokens":5}`; got != want {
		t.Fatalf("model usage = %q, want %s", got, want)
	}
}

func TestUsage_FailedRun_PostsErrorWithZeroTokens(t *testing.T) {
	got := usageBody(t, harness.Spec{}, harness.Result{}, errors.New("claude: 401"))
	if want := `{"cost_usd":0,"error":"claude: 401","job":"d1","provider":"anthropic","source":"org","tokens":0}`; got != want {
		t.Fatalf("model usage = %q, want %s", got, want)
	}
}

func TestUsage_PostsJobIDNotPerson(t *testing.T) {
	fork := fakeFork(t, "#!/bin/sh\necho '{\"is_error\":false,\"total_cost_usd\":0.25,\"usage\":{\"input_tokens\":100,\"output_tokens\":20},\"result\":\"done\"}'\n")
	var usage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/work/model-usage" {
			b, _ := io.ReadAll(r.Body)
			usage = string(b)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	client = &api.Client{BaseURL: srv.URL, Token: "rt"}
	defer func() { client = nil }()
	runner := "a1"
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop", RunnerID: &runner}, ForkRemote: fork,
		Change: &api.Change{ID: "c1", Intent: "go", TargetBranch: "main"}})
	if rep.Status != "done" {
		t.Fatalf("report = %+v, want done", rep)
	}
	want := `{"cost_usd":0.25,"job":"d1","provider":"anthropic","source":"org","tokens":120}`
	if strings.TrimSpace(usage) != want {
		t.Fatalf("model usage = %q, want %s", usage, want)
	}
}

func TestRun_VersionPrompt_SentAsSystemPromptWithIntentAsTask(t *testing.T) {
	args := filepath.Join(t.TempDir(), "args")
	fork := fakeFork(t, "#!/bin/sh\nprintf '%s\\n' \"$@\" > "+args+"\necho '{\"is_error\":false,\"result\":\"done\"}'\n")
	claim := func(prompt string) []string {
		c := &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork,
			Change: &api.Change{ID: "c1", Intent: "say hello", TargetBranch: "main"}, Agent: &api.Agent{Agent: "dev", Version: 2, Prompt: prompt}}
		if rep := run(context.Background(), c); rep.Status != "done" {
			t.Fatalf("report = %+v, want done", rep)
		}
		b, err := os.ReadFile(args)
		if err != nil {
			t.Fatal(err)
		}
		return strings.Split(strings.TrimSpace(string(b)), "\n")
	}
	got := strings.Join(claim("You are dev."), " ")
	if !strings.Contains(got, "-p say hello ") || !strings.Contains(got, "--system-prompt You are dev.") {
		t.Fatalf("claude args = %q, want -p say hello and --system-prompt You are dev.", got)
	}
	if got := strings.Join(claim(""), " "); strings.Contains(got, "--system-prompt") {
		t.Fatalf("claude args = %q, want no --system-prompt for a version with no prompt", got)
	}
}

func TestRun_UsageOverMaxSpend_StopsAndReportsFailed(t *testing.T) {
	args := filepath.Join(t.TempDir(), "args")
	fork := fakeFork(t, "#!/bin/sh\nprintf '%s\\n' \"$@\" > "+args+"\necho '{\"is_error\":true,\"total_cost_usd\":1.5,\"result\":\"budget\"}'\nexit 1\n")
	a := &api.Agent{Agent: "dev", Version: 2}
	a.Limits.MaxSpend = 1
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork,
		Change: &api.Change{ID: "c1", Intent: "say hello", TargetBranch: "main"}, Agent: a})
	if rep.Status != "failed" || rep.Detail != "max spend reached" {
		t.Fatalf("report = %+v, want failed with max spend reached", rep)
	}
	// The harness itself stops at the limit.
	if b, _ := os.ReadFile(args); !strings.Contains(string(b), "--max-budget-usd\n1\n") {
		t.Fatalf("claude args = %q, want --max-budget-usd 1", b)
	}
}

func TestRun_UsageOverMaxTokens_StopsAndReportsFailed(t *testing.T) {
	fork := fakeFork(t, "#!/bin/sh\necho '{\"is_error\":true,\"total_cost_usd\":0.1,\"usage\":{\"input_tokens\":800,\"output_tokens\":300},\"result\":\"x\"}'\nexit 1\n")
	for _, limits := range []struct{ run, month, used int64 }{{1000, 0, 0}, {0, 5000, 4000}} {
		a := &api.Agent{Agent: "dev", Version: 2}
		a.Limits.MaxTokens, a.Limits.MaxTokensMonth, a.Limits.TokensMonth = limits.run, limits.month, limits.used
		rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork,
			Change: &api.Change{ID: "c1", Intent: "say hello", TargetBranch: "main"}, Agent: a})
		if rep.Status != "failed" || rep.Detail != "max tokens reached" {
			t.Fatalf("limits %+v: report = %+v, want failed with max tokens reached", limits, rep)
		}
	}
}

func TestRun_DevelopClaim_ReportIncludesThePushWritesAndReads(t *testing.T) {
	fork := fakeFork(t, "#!/bin/sh\nsed -i 's/return 1/B(); return 2/' a.go\necho '{\"is_error\":false,\"result\":\"done\"}'\n")
	seed := filepath.Join(t.TempDir(), "seed")
	gitOut(t, ".", "clone", "--quiet", fork, seed)
	if err := os.WriteFile(filepath.Join(seed, "a.go"), []byte("package p\n\nfunc A() int {\n\treturn 1\n}\n\nfunc B() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, seed, "add", "a.go")
	gitOut(t, seed, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "--quiet", "-m", "a")
	gitOut(t, seed, "push", "--quiet", "origin", "main")
	rep := run(context.Background(), &api.Claim{Job: api.Job{ID: "d1", Kind: "develop"}, ForkRemote: fork, Change: &api.Change{ID: "c1", TargetBranch: "main"}})
	b, _ := json.Marshal(rep)
	var got struct {
		Writes []map[string]string `json:"writes"`
		Reads  []string            `json:"reads"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got.Writes) != "[map[kind:body symbol:a.go#A]]" || fmt.Sprint(got.Reads) != "[a.go#B]" {
		t.Fatalf("report = %s, want writes [a.go#A body] and reads [a.go#B]", b)
	}
}

func TestRunClaim_PostsModelUsage(t *testing.T) {
	fork := fakeFork(t, "#!/bin/sh\necho '{\"is_error\":false,\"total_cost_usd\":0.25,\"usage\":{\"input_tokens\":100,\"output_tokens\":20},\"result\":\"done\"}'\n")
	var usage, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/work/model-usage" {
			b, _ := io.ReadAll(r.Body)
			usage, auth = string(b), r.Header.Get("Authorization")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	t.Setenv("CINDER_URL", srv.URL)
	t.Setenv("CINDER_RUNNER_TOKEN", "rt")
	defer func() { client = nil }()
	runner := "a1"
	claim, _ := json.Marshal(api.Claim{Job: api.Job{ID: "d1", Kind: "develop", RunnerID: &runner}, ForkRemote: fork,
		Change: &api.Change{ID: "c1", Intent: "go", TargetBranch: "main"}})
	var out strings.Builder
	if err := runClaim(bytes.NewReader(claim), &out); err != nil {
		t.Fatal(err)
	}
	var rep api.Report
	if err := json.Unmarshal([]byte(out.String()), &rep); err != nil || rep.Status != "done" {
		t.Fatalf("report = %q, want done", out.String())
	}
	want := `{"cost_usd":0.25,"job":"d1","provider":"anthropic","source":"org","tokens":120}`
	if strings.TrimSpace(usage) != want || auth != "Bearer rt" {
		t.Fatalf("model usage = %q (auth %q), want %s with the runner token", usage, auth, want)
	}
}
