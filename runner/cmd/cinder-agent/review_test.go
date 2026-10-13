package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/harness"
)

// reviewServer is a Worker serving job j1's diff (one added line in a.txt) and a fake claude answering answer (the
// model's text); it returns the Worker client and the file the prompt is written to. git on PATH fails the test.
func reviewServer(t *testing.T, answer string) (c *api.Client, prompt string) {
	t.Helper()
	result, err := json.Marshal(map[string]any{"is_error": false, "result": answer})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	out, prompt, bin := filepath.Join(dir, "out.json"), filepath.Join(dir, "prompt"), filepath.Join(dir, "bin")
	if err := os.WriteFile(out, result, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, script := range map[string]string{
		"claude": "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + prompt + "\ncat " + out + "\n",
		"git":    "#!/bin/sh\necho \"$@\" > " + filepath.Join(dir, "git-ran") + "\nexit 1\n",
	} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Cleanup(func() {
		if b, err := os.ReadFile(filepath.Join(dir, "git-ran")); err == nil {
			t.Errorf("review ran git %s", b)
		}
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/work/jobs/j1/diff" || r.Header.Get("Authorization") != "Bearer rt" {
			http.Error(w, "{}", http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"diff": "diff --git a/a.txt b/a.txt\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+total = price * qty\n"})
	}))
	t.Cleanup(srv.Close)
	return &api.Client{BaseURL: srv.URL, Token: "rt"}, prompt
}

func TestReview_DiffFromWorker_NoClone_ReportsFailedWithLineFindings(t *testing.T) {
	c, prompt := reviewServer(t, "Looked at it.\n"+
		`{"verdict":"fail","summary":"rounding is missing","findings":[{"path":"a.txt","line":1,"body":"round to the cent"},{"path":"","line":0,"body":"no place"}]}`)

	rep, err := reviewChange(context.Background(), c, "j1", "round totals to the cent", nil, harness.Spec{Prompt: "review"}, &harness.Result{})
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
	c, _ := reviewServer(t, `{"verdict":"pass","summary":"meets the intent","findings":[]}`)

	rep, err := reviewChange(context.Background(), c, "j1", "an intent", nil, harness.Spec{}, &harness.Result{})
	if err != nil || rep.Status != "done" || len(rep.Findings) != 0 {
		t.Fatalf("report = %+v, err = %v; want done", rep, err)
	}
}

func TestReview_NoVerdict_IsAnError(t *testing.T) {
	c, _ := reviewServer(t, "I could not decide.")

	if _, err := reviewChange(context.Background(), c, "j1", "an intent", nil, harness.Spec{}, &harness.Result{}); err == nil || !strings.Contains(err.Error(), "no verdict") {
		t.Fatalf("err = %v, want reviewer gave no verdict", err)
	}
}
