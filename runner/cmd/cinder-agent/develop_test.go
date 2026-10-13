package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/edits"
	"github.com/brinkercode/cinder/runner/internal/harness"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// fakeFork makes a bare fork with one commit and puts a fake claude running script on PATH.
func fakeFork(t *testing.T, script string) string {
	t.Helper()
	// The test commits, and so does develop(); keep the host's signing config out.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	fork, seed, bin := filepath.Join(root, "fork.git"), filepath.Join(root, "seed"), filepath.Join(root, "bin")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, root, "init", "--quiet", "-b", "main", seed)
	gitOut(t, seed, "commit", "--quiet", "--allow-empty", "-m", "seed")
	gitOut(t, seed, "push", "--quiet", fork, "main")

	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return fork
}

func TestDevelop_FakeClaude_PushesCommitToBareRepoAndReportsSha(t *testing.T) {
	// The fake claude edits a file in its working directory, as an agent would.
	script := "#!/bin/sh\necho hello > hello.txt\n" +
		"echo '{\"type\":\"result\",\"is_error\":false,\"total_cost_usd\":0.5,\"session_id\":\"sess-1\",\"result\":\"done\"}'\n"
	fork := fakeFork(t, script)

	d, err := develop(context.Background(), "", fork, "main", "", nil, nil, false, harness.Spec{Prompt: "say hello"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if head := gitOut(t, fork, "rev-parse", "main"); d.Head != head {
		t.Fatalf("reported head %q, fork main is %q", d.Head, head)
	}
	if author := gitOut(t, fork, "log", "-1", "--format=%an", "main"); author != "cinder-agent" {
		t.Fatalf("author = %q, want cinder-agent", author)
	}
	if d.CostUSD != 0.5 || d.SessionID != "sess-1" || !slices.Equal(d.Files, []string{"hello.txt"}) ||
		!slices.Equal(d.Symbols, []symbols.Touch{{Path: "hello.txt", New: true}}) {
		t.Fatalf("report = %+v, want cost 0.5, session sess-1, files [hello.txt], new symbol hello.txt", d)
	}
}

func TestDevelop_SecondRunner_PromptContainsFirstAttemptSummaryAndFailingLogTail(t *testing.T) {
	args := filepath.Join(t.TempDir(), "args")
	// The fake claude records its arguments, one per line, outside the clone.
	fork := fakeFork(t, "#!/bin/sh\nprintf '%s\\n' \"$@\" > "+args+"\n"+
		"echo '{\"is_error\":false,\"session_id\":\"sess-2\",\"result\":\"done\"}'\n")
	prior := []api.Attempt{{Runner: "runner-a", SessionID: "sess-1",
		Summary: "added the claim route", LogTail: "FAIL TestClaim_ExpiredLease"}}

	if _, err := develop(context.Background(), "", fork, "main", "runner-b", prior, nil, false, harness.Spec{Prompt: "fix it"}, nil); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(args)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	for _, want := range []string{"added the claim route", "FAIL TestClaim_ExpiredLease", "fix it"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "--resume") {
		t.Errorf("runner-b resumed runner-a's session:\n%s", got)
	}
}

func TestDevelop_HarnessGetsEgressProxyEnv(t *testing.T) {
	env := filepath.Join(t.TempDir(), "env")
	fork := fakeFork(t, "#!/bin/sh\necho \"$HTTPS_PROXY $HTTP_PROXY\" > "+env+"\n"+
		"echo '{\"is_error\":false,\"result\":\"done\"}'\n")
	if _, err := develop(context.Background(), "", fork, "main", "", nil, []string{"*.github.com"}, false, harness.Spec{Prompt: "go"}, nil); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(env)
	if err != nil {
		t.Fatal(err)
	}
	proxies := strings.Fields(string(b))
	if len(proxies) != 2 || proxies[0] != proxies[1] || !strings.HasPrefix(proxies[0], "http://127.0.0.1:") {
		t.Fatalf("HTTPS_PROXY HTTP_PROXY = %q, want the same loopback proxy URL", b)
	}
}

func TestDevelop_FinishGate_OpenCollisionIsPushedForCinderToSettle(t *testing.T) {
	// The fake claude writes a function the edit check reports an open error on, and asks to finish.
	fork := fakeFork(t, "#!/bin/sh\nprintf 'package a\\n\\nfunc F(x int) {}\\n' > a.go\n"+
		"echo '{\"is_error\":false,\"session_id\":\"sess-1\",\"result\":\"done\"}'\n")
	check := func(_ context.Context, _ string, writes []symbols.Write, _ []string) ([]edits.Diagnostic, error) {
		return []edits.Diagnostic{{Severity: "error", File: "a.go", Symbol: writes[0].Symbol, Change: "c1", Intent: "rename F",
			Suggestion: "stack on c1, which is verified and holds a.go#F"}}, nil
	}
	d, err := develop(context.Background(), "", fork, "main", "", nil, nil, false, harness.Spec{Prompt: "go"}, check)
	if err != nil {
		t.Fatalf("develop error = %v, want the run to finish so cinder settles the collision", err)
	}
	if got := gitOut(t, fork, "rev-parse", "main"); got != d.Head {
		t.Fatalf("fork main = %s, want the developed head %s pushed", got, d.Head)
	}
}

func TestDevelop_ForkHeadIsNotTargetBranch_PushesTargetBranch(t *testing.T) {
	fork := fakeFork(t, "#!/bin/sh\necho hello > hello.txt\necho '{\"is_error\":false,\"session_id\":\"s\",\"result\":\"done\"}'\n")
	// The fork's HEAD is main (as a repo whose default branch was created later); the change targets develop, one commit ahead.
	seed := filepath.Join(t.TempDir(), "seed")
	gitOut(t, filepath.Dir(seed), "clone", "--quiet", fork, seed)
	gitOut(t, seed, "commit", "--quiet", "--allow-empty", "-m", "develop start")
	gitOut(t, seed, "push", "--quiet", "origin", "HEAD:develop")
	mainTip := gitOut(t, fork, "rev-parse", "main")

	d, err := develop(context.Background(), "", fork, "develop", "", nil, nil, false, harness.Spec{Prompt: "go"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, fork, "rev-parse", "develop"); got != d.Head {
		t.Fatalf("fork develop is %s, want the developed head %s", got, d.Head)
	}
	if got := gitOut(t, fork, "rev-parse", "main"); got != mainTip {
		t.Fatalf("fork main moved to %s", got)
	}
}
