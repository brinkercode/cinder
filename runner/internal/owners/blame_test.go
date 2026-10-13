package owners

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func repo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", "--quiet", "-b", "main", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	return dir
}

// blamed builds main with a line ren wrote by hand and a line merged from change c-7 by patch@v3, and blames it.
func blamed(t *testing.T) ([]Line, string) {
	t.Helper()
	dir := repo(t)
	git := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=ren", "GIT_AUTHOR_EMAIL=ren@x",
			"GIT_COMMITTER_NAME=ren", "GIT_COMMITTER_EMAIL=ren@x")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(s string) {
		if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("by hand\n")
	git("add", "a.go")
	git("commit", "--quiet", "-m", "seed")
	git("checkout", "--quiet", "-b", "fork")
	write("by hand\nby agent\n")
	git("commit", "--quiet", "-am", "agent edit")
	git("checkout", "--quiet", "main")
	git("merge", "--quiet", "--no-ff", "-m", "cinder: merge change c-7\n\nCinder-Change: c-7\nCinder-Agent: patch@v3", "fork")
	lines, err := Blame(context.Background(), dir, "main", "a.go")
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 {
		t.Fatalf("lines %+v: want 2", lines)
	}
	return lines, git("rev-parse", "main")
}

func TestBlame_MergedChangeLine_ReturnsChangeIDAndAgentVersion(t *testing.T) {
	lines, merge := blamed(t)
	if want := (Line{Commit: merge, Change: "c-7", Agent: "patch@v3"}); lines[1] != want {
		t.Fatalf("line 2 = %+v, want %+v", lines[1], want)
	}
}

func TestBlame_HandWrittenLine_ReturnsPerson(t *testing.T) {
	lines, _ := blamed(t)
	if l := lines[0]; l.Person != "ren" || l.Change != "" || l.Agent != "" || len(l.Commit) < 40 {
		t.Fatalf("line 1 = %+v, want ren's commit with no change or agent", l)
	}
}
