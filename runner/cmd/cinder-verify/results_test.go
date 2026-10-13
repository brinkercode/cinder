package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
)

// resultRepo is a repo with two commits: base adds a.go, head changes it and adds b.js. It returns the dir and both shas.
func resultRepo(t *testing.T) (dir, base, head string) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	dir = t.TempDir()
	git := func(args ...string) string {
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Ann", "-c", "user.email=ann@x.test"}, args...)...).Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(name, src string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q", "-b", "main")
	write("a.go", "package a\n\nfunc One() {}\n")
	git("add", ".")
	git("commit", "-q", "-m", "base")
	base = git("rev-parse", "HEAD")
	write("a.go", "package a\n\nfunc Two() {}\n")
	write("b.js", "export function three() {}\n")
	git("add", ".")
	git("commit", "-q", "-m", "head")
	return dir, base, git("rev-parse", "HEAD")
}

// runPut dispatches a claim of kind for remote and returns the report and the one PUT it sent: its path and body.
func runPut(t *testing.T, kind, remote, payload string) (api.Report, string, string) {
	t.Helper()
	var path, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if r.Method == http.MethodPut {
			path, body = r.URL.RequestURI(), string(b)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	rep := dispatch(&api.Client{BaseURL: srv.URL, Token: "t"})(context.Background(),
		&api.Claim{Job: api.Job{ID: "j1", Kind: kind}, TargetRemote: remote, Payload: json.RawMessage(payload)})
	return rep, path, body
}

func TestIndexJob_SmallRepo_ReportsItsSymbols(t *testing.T) {
	dir, base, _ := resultRepo(t)
	rep, path, body := runPut(t, "index", dir, `{"repo":"r","target":"main","sha":"`+base+`"}`)
	if rep.Status != "done" || path != "/api/work/repos/r/symbols/"+base {
		t.Fatalf("report = %+v, PUT %q", rep, path)
	}
	var syms []struct{ Path, Name string }
	if err := json.Unmarshal([]byte(body), &syms); err != nil || len(syms) != 1 || syms[0].Path != "a.go" || syms[0].Name != "One" {
		t.Fatalf("symbols at base = %s, want only a.go One", body)
	}
}

func TestBlameJob_ReportsAuthoringCommitPerLine(t *testing.T) {
	dir, base, head := resultRepo(t)
	rep, path, body := runPut(t, "blame", dir, `{"repo":"r","store":"r","sha":"`+head+`","path":"a.go"}`)
	if rep.Status != "done" || path != "/api/work/repos/r/authorship/"+head+"?path=a.go" {
		t.Fatalf("report = %+v, PUT %q", rep, path)
	}
	var lines []struct{ Commit, Person string }
	if err := json.Unmarshal([]byte(body), &lines); err != nil || len(lines) != 3 {
		t.Fatalf("authorship = %s, want 3 lines", body)
	}
	for i, want := range []string{base, base, head} {
		if lines[i].Commit != want || lines[i].Person != "Ann" {
			t.Errorf("line %d = %+v, want commit %s by Ann", i+1, lines[i], want)
		}
	}
}

func TestCompareJob_ReportsAddsDelsAndFilesBetweenShas(t *testing.T) {
	dir, base, head := resultRepo(t)
	rep, path, body := runPut(t, "compare", dir, `{"repo":"r","store":"r","base":"`+base+`","head":"`+head+`"}`)
	if rep.Status != "done" || path != "/api/work/repos/r/compare/"+base+"/"+head {
		t.Fatalf("report = %+v, PUT %q", rep, path)
	}
	var got struct {
		Ahead, Behind int
		Commits       []struct{ Sha, Message string }
		Files         []compareFile
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Ahead != 1 || got.Behind != 0 || len(got.Commits) != 1 || got.Commits[0].Sha != head || got.Commits[0].Message != "head" {
		t.Fatalf("compare = %s, want 1 ahead, 0 behind, commit head", body)
	}
	if len(got.Files) != 2 {
		t.Fatalf("files = %+v, want a.go and b.js", got.Files)
	}
	a, b := got.Files[0], got.Files[1]
	if a.Path != "a.go" || a.Status != "modified" || a.Additions != 1 || a.Deletions != 1 || !strings.HasPrefix(a.Patch, "@@") ||
		b.Path != "b.js" || b.Status != "added" || b.Additions != 1 || b.Deletions != 0 {
		t.Fatalf("files = %+v", got.Files)
	}
}
