package mergeprobe

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// repo returns a repo whose main has f.txt = base, and branches ours and theirs editing it.
func repo(t *testing.T, base, ours, theirs string) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	dir := t.TempDir()
	git(t, dir, "init", "--quiet", "-b", "main")
	commit := func(branch, content string) {
		git(t, dir, "checkout", "--quiet", "-B", branch, "main")
		if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		git(t, dir, "add", "f.txt")
		git(t, dir, "commit", "--quiet", "-m", branch)
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(base), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", "f.txt")
	git(t, dir, "commit", "--quiet", "-m", "base")
	commit("ours", ours)
	commit("theirs", theirs)
	return dir
}

func TestProbe_AdjacentEdits_Clean(t *testing.T) {
	dir := repo(t, "a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n")
	r, err := Probe(dir, "", "ours", "theirs")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Clean || len(r.Files) != 0 {
		t.Fatalf("result = %+v, want clean", r)
	}
}

func TestProbe_SameLineEdits_ReportsFileAndMarkers(t *testing.T) {
	dir := repo(t, "a\nb\nc\n", "A\nb\nc\n", "Z\nb\nc\n")
	r, err := Probe(dir, git(t, dir, "rev-parse", "main"), "ours", "theirs")
	if err != nil {
		t.Fatal(err)
	}
	blob := func(rev string) string { return git(t, dir, "rev-parse", rev+":f.txt") }
	want := File{Path: "f.txt", Markers: 1, BaseBlob: blob("main"), OursBlob: blob("ours"), TheirsBlob: blob("theirs")}
	if r.Clean || len(r.Files) != 1 || r.Files[0] != want {
		t.Fatalf("result = %+v, want one file %+v", r, want)
	}
}

func TestProbe_FatalOnExit1_ReturnsError(t *testing.T) {
	bin := t.TempDir()
	// A well-formed conflict on stdout, so only the fatal: on stderr marks this exit 1 as an error.
	script := `#!/bin/sh
[ "$3" = merge-tree ] || { echo '<<<<<<< ours'; exit 0; }
printf 'tree\000'
printf '100644 abc 2\tf.txt\000\000'
echo 'fatal: something broke' >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	r, err := Probe(t.TempDir(), "", "ours", "theirs")
	if err == nil || r.Clean {
		t.Fatalf("result = %+v, err = %v; want an error", r, err)
	}
}

func TestProbe_UnrelatedHistories_ReturnsError(t *testing.T) {
	dir := repo(t, "a\n", "b\n", "c\n")
	git(t, dir, "checkout", "--quiet", "--orphan", "unrelated")
	git(t, dir, "commit", "--quiet", "-m", "unrelated")
	r, err := Probe(dir, "", "ours", "unrelated")
	if err == nil || r.Clean {
		t.Fatalf("result = %+v, err = %v; want an error", r, err)
	}
}
