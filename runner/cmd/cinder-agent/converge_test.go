package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestConverge_CleanRebase_PushesForkHeadDescendingFromNewTarget(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, root, "clone", "--quiet", "--bare", target, fork)
	// The fork gains a change; then the target advances on a different file.
	write := func(name string) {
		if err := os.WriteFile(filepath.Join(work, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		gitOut(t, work, "add", name)
		gitOut(t, work, "commit", "--quiet", "-m", name)
	}
	write("fork.txt")
	gitOut(t, work, "push", "--quiet", fork, "main")
	gitOut(t, work, "reset", "--quiet", "--hard", "HEAD~1")
	write("target.txt")
	gitOut(t, work, "push", "--quiet", target, "main")
	newTarget := gitOut(t, target, "rev-parse", "main")

	head, _, err := converge(context.Background(), "", "", fork, target, "main")
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, fork, "rev-parse", "main"); got != head {
		t.Fatalf("fork main = %s, converge returned %s", got, head)
	}
	if err := exec.Command("git", "-C", fork, "merge-base", "--is-ancestor", newTarget, "main").Run(); err != nil {
		t.Fatalf("fork head %s does not descend from new target %s", head, newTarget)
	}
	if files := gitOut(t, fork, "ls-tree", "--name-only", "main"); files != "fork.txt\ntarget.txt" {
		t.Fatalf("fork tree = %q", files)
	}
}

func TestConverge_SameLineEdits_ReportsConflictWithoutPushing(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	write := func(content string) {
		if err := os.WriteFile(filepath.Join(work, "f.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		gitOut(t, work, "commit", "--quiet", "-am", content)
	}
	if err := os.WriteFile(filepath.Join(work, "f.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, work, "add", "f.txt")
	write("base\n")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, root, "clone", "--quiet", "--bare", target, fork)
	write("fork\n")
	gitOut(t, work, "push", "--quiet", fork, "main")
	forkHead := gitOut(t, fork, "rev-parse", "main")
	gitOut(t, work, "reset", "--quiet", "--hard", "HEAD~1")
	write("target\n")
	gitOut(t, work, "push", "--quiet", target, "main")

	_, c, err := converge(context.Background(), "", "", fork, target, "main")
	if err != nil {
		t.Fatal(err)
	}
	if c == nil || len(c.Files) != 1 || c.Files[0] != "f.txt" || len(c.Hunks) != 1 || c.Hunks[0].Path != "f.txt" || c.Hunks[0].Markers != 1 {
		t.Fatalf("conflict = %+v, want f.txt with one marker", c)
	}
	if got := gitOut(t, fork, "rev-parse", "main"); got != forkHead {
		t.Fatalf("fork main moved to %s, want %s", got, forkHead)
	}
}

func TestConverge_ForkHeadIsNotTargetBranch_RebasesAndPushesTargetBranch(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	// The fork's HEAD is main; the change lives on develop, which the target has since moved past.
	gitOut(t, root, "clone", "--quiet", "--bare", target, fork)
	gitOut(t, work, "checkout", "--quiet", "-b", "develop")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "fork change")
	gitOut(t, work, "push", "--quiet", fork, "develop")
	gitOut(t, work, "reset", "--quiet", "--hard", "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "target moved")
	gitOut(t, work, "push", "--quiet", target, "HEAD:develop")
	newTarget := gitOut(t, target, "rev-parse", "develop")

	head, _, err := converge(context.Background(), "", "", fork, target, "develop")
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, fork, "rev-parse", "develop"); got != head {
		t.Fatalf("fork develop = %s, converge returned %s", got, head)
	}
	if err := exec.Command("git", "-C", fork, "merge-base", "--is-ancestor", newTarget, "develop").Run(); err != nil {
		t.Fatalf("fork develop %s does not descend from new target %s", head, newTarget)
	}
	if got := gitOut(t, fork, "log", "-1", "--format=%s", "develop"); got != "fork change" {
		t.Fatalf("fork develop head = %q, want the fork's change rebased", got)
	}
}
