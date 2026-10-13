package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The fresh-account run-through: the README (deploy), docs/operations (runners, judges) and docs/usage/changes.md
// (a first change) cover it, and every cinder command they give runs against the API.
func TestReadme_CleanNamespace_ReachesFirstChange(t *testing.T) {
	var firstChange string
	for _, doc := range []struct{ file, heading string }{{"README.md", "## Deploy"}, {"docs/operations/README.md", "## Register a runner"},
		{"docs/operations/README.md", "## Configure judges"}, {"docs/usage/changes.md", "## Your first change"}} {
		b, err := os.ReadFile("../../../" + doc.file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), "\n"+doc.heading+"\n") {
			t.Errorf("%s has no %q section", doc.file, doc.heading)
		}
		if doc.file == "docs/usage/changes.md" {
			firstChange = string(b)
		}
	}
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	word := regexp.MustCompile(`"[^"]*"|\S+`)
	for _, m := range regexp.MustCompile(`(?m)^go run \./cmd/cinder ([^#\n]*)`).FindAllStringSubmatch(firstChange, -1) {
		var args []string
		for _, w := range word.FindAllString(m[1], -1) {
			args = append(args, strings.Trim(strings.ReplaceAll(w, "<id>", "c1"), `"`))
		}
		if err := run(args, srv.URL, "owner-token", io.Discard); err != nil {
			t.Errorf("README command cinder %s: %v", m[1], err)
		}
	}
	want := []string{"POST /api/repos", "POST /api/repos/pulse/changes", "GET /api/changes/c1"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Errorf("docs/usage/changes.md's first change calls %v, want %v", paths, want)
	}
}
