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
