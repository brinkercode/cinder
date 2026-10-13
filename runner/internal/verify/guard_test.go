package verify

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGuard_PushWithLiveKeyAndNewDependency_Reported(t *testing.T) {
	tmp := t.TempDir()
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main fork; echo '{"dependencies":{"react":"^19.1.0"}}' > fork/package.json
git -C fork add .; git -C fork commit -qm base; git -C fork rev-parse HEAD
echo '{"dependencies":{"react":"^19.1.0","left-pad":"1.3.0"}}' > fork/package.json
echo 'key = "sk_live_abcdefghijklmnopqrstuvwx"' > fork/pay.js
git -C fork add .; git -C fork commit -qm push; git -C fork rev-parse HEAD`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	shas := strings.Fields(string(out))
	rep := Guard(context.Background(), filepath.Join(t.TempDir(), "g"), "", filepath.Join(tmp, "fork"), shas[0], shas[1], "")
	if rep.Status != "done" || len(rep.Findings) != 1 || rep.Findings[0].Rule != "stripe_secret_key" || rep.Findings[0].File != "pay.js" {
		t.Fatalf("want the live key in pay.js reported, got %+v", rep)
	}
	if len(rep.Deps) != 1 || rep.Deps[0].Name != "left-pad" || rep.Deps[0].Version != "1.3.0" {
		t.Fatalf("want only the added left-pad, got %+v", rep.Deps)
	}
	if !strings.Contains(rep.Diff, "+key = ") {
		t.Fatalf("want the pushed diff, got %q", rep.Diff)
	}
}

func TestGuard_FirstHeadOnRefsFor_ComparedFromTargetMergeBase(t *testing.T) {
	tmp := t.TempDir()
	// main already holds a key; the person's push under refs/for/main adds only a new one.
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main fork; echo 'old = "sk_live_aaaaaaaaaaaaaaaaaaaaaaaa"' > fork/old.js
git -C fork add .; git -C fork commit -qm base
git -C fork switch -q -c topic; echo 'key = "sk_live_abcdefghijklmnopqrstuvwx"' > fork/pay.js
git -C fork add .; git -C fork commit -qm push; git -C fork update-ref refs/for/main HEAD; git -C fork switch -q main
git -C fork branch -q -D topic; git -C fork rev-parse refs/for/main`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	after := strings.TrimSpace(string(out))
	rep := Guard(context.Background(), filepath.Join(t.TempDir(), "g"), "", filepath.Join(tmp, "fork"), "", after, "main")
	if rep.Status != "done" || len(rep.Findings) != 1 || rep.Findings[0].File != "pay.js" {
		t.Fatalf("want only the pushed key in pay.js, got %+v", rep)
	}
}

func TestGuard_BeforeNoLongerInFork_ReadsWholeHistory(t *testing.T) {
	tmp := t.TempDir()
	// A converge force-pushes the fork rebased onto main, so the pushed-over head (before) is gone from it.
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main fork; echo 'old = "sk_live_aaaaaaaaaaaaaaaaaaaaaaaa"' > fork/old.js
git -C fork add .; git -C fork commit -qm base
git -C fork switch -q -c develop; echo 'key = "sk_live_abcdefghijklmnopqrstuvwx"' > fork/pay.js
git -C fork add .; git -C fork commit -qm push; git -C fork rev-parse HEAD`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	after := strings.TrimSpace(string(out))
	rep := Guard(context.Background(), filepath.Join(t.TempDir(), "g"), "", filepath.Join(tmp, "fork"), strings.Repeat("1", 40), after, "")
	if rep.Status != "done" || len(rep.Findings) != 2 || !strings.Contains(rep.Diff, "+key = ") {
		t.Fatalf("want the history read whole (both keys), got %+v", rep)
	}
}
