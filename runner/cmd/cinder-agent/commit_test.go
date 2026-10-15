package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCommitEdit_WritesContentToFork(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	fork, work := filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", fork, "main")

	content := "export const a = 2;\r\n\tkept as typed\n"
	if _, _, err := commitEdit(context.Background(), "", fork, "main", "src/a.js", content, "t1"); err != nil {
		t.Fatal(err)
	}
	got, err := exec.Command("git", "-C", fork, "cat-file", "blob", "main:src/a.js").Output()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != content {
		t.Fatalf("src/a.js = %q, want %q", got, content)
	}
	if trailer := gitOut(t, fork, "log", "-1", "--format=%(trailers:key=Cinder-Thread,valueonly)", "main"); trailer != "t1" {
		t.Fatalf("Cinder-Thread trailer = %q, want t1", trailer)
	}
	if _, _, err := commitEdit(context.Background(), "", fork, "main", ".git/hooks/pre-commit", "x", ""); err == nil {
		t.Fatal("a path into .git was written")
	}
}

func TestCommitEdit_Reads_AreExact(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	fork, work := filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	src := "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n"
	if err := os.WriteFile(filepath.Join(work, "a.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, work, "add", "a.js")
	gitOut(t, work, "commit", "--quiet", "-m", "base")
	gitOut(t, work, "push", "--quiet", fork, "main")

	// Only a's body changes and it references nothing: b is neither written nor read.
	edited := "export function a() {\n  return 3;\n}\n\nexport function b() {\n  return 2;\n}\n"
	writes, reads, err := commitEdit(context.Background(), "", fork, "main", "a.js", edited, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(writes) != 1 || writes[0].Symbol != "a.js#a" || writes[0].Kind != "body" {
		t.Fatalf("writes = %v, want [{a.js#a body}]", writes)
	}
	if len(reads) != 0 {
		t.Fatalf("reads = %v, want none", reads)
	}
}

func TestCommitEdit_ForkSymlinks_NeverWriteOutsideTheTreeOrIntoGit(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	fork, work, outside := filepath.Join(root, "fork.git"), filepath.Join(root, "work"), filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	for name, target := range map[string]string{"x": outside, "g": ".git", "f": filepath.Join(outside, "f")} {
		if err := os.Symlink(target, filepath.Join(work, name)); err != nil {
			t.Fatal(err)
		}
	}
	gitOut(t, work, "add", ".")
	gitOut(t, work, "commit", "--quiet", "-m", "symlinks")
	gitOut(t, work, "push", "--quiet", fork, "main")

	for _, path := range []string{"x/evil", "g/hooks/pre-commit"} {
		if _, _, err := commitEdit(context.Background(), "", fork, "main", path, "#!/bin/sh\ntouch "+outside+"/ran\n", ""); err == nil {
			t.Errorf("%s: written through a symlink", path)
		}
	}
	if _, _, err := commitEdit(context.Background(), "", fork, "main", "f", "replaced", ""); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("outside the clone: %v, want nothing written", entries)
	}
	if got := gitOut(t, fork, "cat-file", "-p", "main:f"); got != "replaced" {
		t.Fatalf("f = %q, want the symlink replaced by the edit", got)
	}
}
