package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/harness"
)

func TestResolve_FakeHarness_PushesHeadDescendingFromTarget(t *testing.T) {
	args := filepath.Join(t.TempDir(), "args")
	// The fake claude records its prompt and resolves the conflict by rewriting the file.
	fork := fakeFork(t, "#!/bin/sh\nprintf '%s\\n' \"$@\" > "+args+"\necho resolved > a.txt\n"+
		"echo '{\"is_error\":false,\"result\":\"done\"}'\n")
	root := filepath.Dir(fork)
	target, work := filepath.Join(root, "target.git"), filepath.Join(root, "work")
	gitOut(t, root, "clone", "--quiet", "--bare", fork, target)
	gitOut(t, root, "clone", "--quiet", fork, work)
	commit := func(content, to string) {
		if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte(content+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		gitOut(t, work, "add", "a.txt")
		gitOut(t, work, "commit", "--quiet", "-m", content)
		gitOut(t, work, "push", "--quiet", to, "main")
	}
	commit("ours", fork)
	gitOut(t, work, "reset", "--quiet", "--hard", "HEAD~1")
	commit("theirs", target)
	targetHead := gitOut(t, target, "rev-parse", "main")
	var p resolvePayload
	if err := json.Unmarshal([]byte(`{"intent":"our intent","theirs":[{"id":"c2","intent":"their intent"}],"hunks":[{"file":"a.txt"}],"symbols":["a.txt#greet"]}`), &p); err != nil {
		t.Fatal(err)
	}

	head, err := resolveConflict(context.Background(), "", "", fork, target, "main", p, nil, harness.Spec{Prompt: "resolve"}, &harness.Result{}, &api.Report{})
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, fork, "rev-parse", "main"); got != head {
		t.Fatalf("fork main = %s, resolveConflict returned %s", got, head)
	}
	if err := exec.Command("git", "-C", fork, "merge-base", "--is-ancestor", targetHead, "main").Run(); err != nil {
		t.Fatalf("fork head %s does not descend from target %s", head, targetHead)
	}
	if got := gitOut(t, fork, "show", "main:a.txt"); got != "resolved" {
		t.Fatalf("a.txt = %q, want the harness's resolution", got)
	}
	b, err := os.ReadFile(args)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"our intent", "their intent", "+theirs", `"file":"a.txt"`, "a.txt#greet"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("prompt is missing %q:\n%s", want, b)
		}
	}
}

func TestResolve_ConflictedMergeTouchingPackageJSON_EndsWithRegeneratedLock(t *testing.T) {
	deps := t.TempDir()
	for _, n := range []string{"b", "c"} {
		if err := os.MkdirAll(filepath.Join(deps, n), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(deps, n, "package.json"), []byte(`{"name":"`+n+`","version":"1.0.0"}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	pkg := func(deps string) string { return `{"name":"t","version":"1.0.0","dependencies":{` + deps + "}}\n" }
	dep := func(n string) string { return `"` + n + `":"file:` + filepath.Join(deps, n) + `"` }
	// The fake claude resolves the package.json conflict by keeping both dependencies.
	fork := fakeFork(t, "#!/bin/sh\ncat > package.json <<'X'\n"+pkg(dep("b")+","+dep("c"))+"X\n"+
		"echo '{\"is_error\":false,\"result\":\"done\"}'\n")
	root := filepath.Dir(fork)
	target, work := filepath.Join(root, "target.git"), filepath.Join(root, "work")
	gitOut(t, root, "clone", "--quiet", fork, work)
	commit := func(deps string, to ...string) {
		if err := os.WriteFile(filepath.Join(work, "package.json"), []byte(pkg(deps)), 0o644); err != nil {
			t.Fatal(err)
		}
		npm := exec.Command("npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund")
		npm.Dir = work
		if out, err := npm.CombinedOutput(); err != nil {
			t.Fatalf("npm: %v\n%s", err, out)
		}
		gitOut(t, work, "add", "package.json", "package-lock.json")
		gitOut(t, work, "commit", "--quiet", "-m", "deps "+deps)
		for _, r := range to {
			gitOut(t, work, "push", "--quiet", r, "main")
		}
	}
	commit("", fork)
	gitOut(t, root, "clone", "--quiet", "--bare", fork, target)
	commit(dep("c"), fork)
	gitOut(t, work, "reset", "--quiet", "--hard", "HEAD~1")
	commit(dep("b"), target)

	if _, err := resolveConflict(context.Background(), "", "", fork, target, "main", resolvePayload{}, nil, harness.Spec{Prompt: "resolve"}, &harness.Result{}, &api.Report{}); err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, fork, "rev-list", "--count", "--merges", "main"); got != "1" {
		t.Fatalf("fork main has %s merge commits, want the resolve merge", got)
	}
	lock := gitOut(t, fork, "show", "main:package-lock.json")
	for _, want := range []string{`"node_modules/b"`, `"node_modules/c"`} {
		if !strings.Contains(lock, want) {
			t.Errorf("committed lock lacks %s:\n%s", want, lock)
		}
	}
}
