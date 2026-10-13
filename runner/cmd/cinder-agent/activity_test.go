package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
)

func TestActivity_NewestModifiedFile_PostsEditingPath(t *testing.T) {
	dir := t.TempDir()
	write := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("old.go")
	for _, args := range [][]string{{"init", "-q"}, {"add", "."}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	posts := make(chan map[string]string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/work/jobs/j1/activity" {
			t.Errorf("path %s", r.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		posts <- body
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	client = &api.Client{BaseURL: srv.URL, Token: "rt"}
	defer func() { client = nil }()

	stop := watchActivity(context.Background(), dir, "j1", 20*time.Millisecond)
	defer stop()
	next := func() map[string]string {
		select {
		case b := <-posts:
			return b
		case <-time.After(5 * time.Second):
			t.Fatal("no activity posted")
			return nil
		}
	}
	time.Sleep(50 * time.Millisecond) // nothing written since the watch began: no post
	write("new.go")
	if b := next(); b["activity"] != "editing new.go" || b["path"] != "new.go" {
		t.Fatalf("first post %v", b)
	}
	time.Sleep(20 * time.Millisecond)
	write("old.go")
	if b := next(); b["activity"] != "editing old.go" || b["path"] != "old.go" {
		t.Fatalf("second post %v", b)
	}
	select {
	case b := <-posts:
		t.Fatalf("unexpected post %v", b)
	case <-time.After(100 * time.Millisecond):
	}
}
