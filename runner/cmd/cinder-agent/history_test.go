package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWriteHistory_IntentMatchesByteForByte(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	target := filepath.Join(t.TempDir(), "target.git")
	gitOut(t, t.TempDir(), "init", "--quiet", "--bare", target)
	intent := "Fix the  thing\r\n\ttabs, trailing space \nünïcode\n\n"
	ref := "refs/cinder/changes/c1"
	if err := writeHistory(context.Background(), "", target, ref, map[string]string{
		"intent.md": intent, "acceptance/a_test.go": "package a\n", "events.jsonl": "{}\n",
	}); err != nil {
		t.Fatal(err)
	}
	got, err := exec.Command("git", "-C", target, "cat-file", "blob", ref+":intent.md").Output()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != intent {
		t.Fatalf("intent.md = %q, want %q", got, intent)
	}
	if err := writeHistory(context.Background(), "", target, ref, map[string]string{".git/hooks/pre-commit": "x"}); err == nil {
		t.Fatal("a path into .git was written")
	}
}
