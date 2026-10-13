package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/harness"
)

// reviewFork is a fork whose main adds a.txt over the seed commit, reviewed by a fake claude answering answer
// (the model's text); it returns the fork, the seed sha (the review's base) and the file the prompt is written to.
func reviewFork(t *testing.T, answer string) (fork, base, prompt string) {
	t.Helper()
	result, err := json.Marshal(map[string]any{"is_error": false, "result": answer})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	out, prompt := filepath.Join(dir, "out.json"), filepath.Join(dir, "prompt")
	if err := os.WriteFile(out, result, 0o644); err != nil {
		t.Fatal(err)
	}
	fork = fakeFork(t, "#!/bin/sh\nprintf '%s\\n' \"$@\" > "+prompt+"\ncat "+out+"\n")
	work := filepath.Join(dir, "work")
	gitOut(t, dir, "clone", "--quiet", fork, work)
	base = gitOut(t, work, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("total = price * qty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, work, "add", "a.txt")
	gitOut(t, work, "commit", "--quiet", "-m", "change")
	gitOut(t, work, "push", "--quiet", "origin", "main")
	return fork, base, prompt
}

func TestReview_FailVerdict_ReportsFailedWithLineFindings(t *testing.T) {
	fork, base, prompt := reviewFork(t, "Looked at it.\n"+
		`{"verdict":"fail","summary":"rounding is missing","findings":[{"path":"a.txt","line":1,"body":"round to the cent"},{"path":"","line":0,"body":"no place"}]}`)

	rep, err := reviewChange(context.Background(), "", fork, "main", base, "round totals to the cent", nil, harness.Spec{Prompt: "review"}, &harness.Result{})
	if err != nil {
		t.Fatal(err)
	}
	want := []api.Finding{{Path: "a.txt", Line: 1, Body: "round to the cent"}}
	if rep.Status != "failed" || rep.Detail != "rounding is missing" || len(rep.Findings) != 1 || rep.Findings[0] != want[0] {
		t.Fatalf("report = %+v, want failed with %+v", rep, want)
	}
	b, err := os.ReadFile(prompt)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"round totals to the cent", "+total = price * qty"} {
		if !strings.Contains(string(b), s) {
			t.Errorf("prompt is missing %q:\n%s", s, b)
		}
	}
}

func TestReview_PassVerdict_ReportsDone(t *testing.T) {
	fork, base, _ := reviewFork(t, `{"verdict":"pass","summary":"meets the intent","findings":[]}`)

	rep, err := reviewChange(context.Background(), "", fork, "main", base, "an intent", nil, harness.Spec{}, &harness.Result{})
	if err != nil || rep.Status != "done" || len(rep.Findings) != 0 {
		t.Fatalf("report = %+v, err = %v; want done", rep, err)
	}
}

func TestReview_NoVerdict_IsAnError(t *testing.T) {
	fork, base, _ := reviewFork(t, "I could not decide.")

	if _, err := reviewChange(context.Background(), "", fork, "main", base, "an intent", nil, harness.Spec{}, &harness.Result{}); err == nil || !strings.Contains(err.Error(), "no verdict") {
		t.Fatalf("err = %v, want reviewer gave no verdict", err)
	}
}
