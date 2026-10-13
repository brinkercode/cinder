package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// agentsRepo makes a bare agents repo holding the testdata dev agent.
func agentsRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	bare, seed := filepath.Join(root, "agents.git"), filepath.Join(root, "seed")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", bare)
	gitOut(t, root, "init", "--quiet", "-b", "main", seed)
	if err := os.CopyFS(filepath.Join(seed, "agents", "dev"), os.DirFS("testdata/agents/dev")); err != nil {
		t.Fatal(err)
	}
	gitOut(t, seed, "add", ".")
	gitOut(t, seed, "commit", "--quiet", "-m", "seed")
	gitOut(t, seed, "push", "--quiet", bare, "main")
	return bare
}

func TestRelease_LockContainsPromptSha256(t *testing.T) {
	bare := agentsRepo(t)
	if _, err := release(context.Background(), "", bare, "dev", nil); err != nil {
		t.Fatal(err)
	}
	var l lock
	if err := json.Unmarshal([]byte(gitOut(t, bare, "tag", "--list", "--format=%(contents)", "agent/dev/v1")), &l); err != nil {
		t.Fatal(err)
	}
	prompt, err := os.ReadFile("testdata/agents/dev/prompt.md")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(prompt)
	if want := "sha256:" + hex.EncodeToString(sum[:]); l.PromptHash != want {
		t.Fatalf("prompt_hash = %q, want %q", l.PromptHash, want)
	}
	if l.Harness != "claude-code" || l.Model != "claude-opus-5-5" || l.Effort != "medium" || len(l.Tools) != 3 ||
		l.Limits["max_cost_usd"] != 8 || l.Limits["max_minutes"] != 120 {
		t.Fatalf("lock = %+v", l)
	}
	if typ := gitOut(t, bare, "cat-file", "-t", "agent/dev/v1"); typ != "tag" {
		t.Fatalf("agent/dev/v1 is a %s, want an annotated tag", typ)
	}
}

func TestRelease_VersionsIncrementByOne(t *testing.T) {
	bare := agentsRepo(t)
	for want := 1; want <= 3; want++ {
		l, err := release(context.Background(), "", bare, "dev", nil)
		if err != nil {
			t.Fatal(err)
		}
		if l.Version != want {
			t.Fatalf("release %d got version %d", want, l.Version)
		}
	}
	if tags := gitOut(t, bare, "tag", "--list", "agent/dev/*"); tags != "agent/dev/v1\nagent/dev/v2\nagent/dev/v3" {
		t.Fatalf("tags = %q", tags)
	}
}

func TestRelease_Draft_CommitsDraftAndTagsLockWithEgress(t *testing.T) {
	bare := agentsRepo(t)
	d := &draft{Harness: "claude-code", Model: "claude-opus-5-5", Effort: "high", Tools: []string{"bash"}, Egress: []string{"pkg.go.dev"},
		Web: "raw", Limits: map[string]float64{"max_cost_usd": 4, "max_minutes": 30}, Prompt: "You are dev v2."}
	if _, err := release(context.Background(), "", bare, "dev", d); err != nil {
		t.Fatal(err)
	}
	msg := gitOut(t, bare, "tag", "--list", "--format=%(contents)", "agent/dev/v1")
	var l lock
	if err := json.Unmarshal([]byte(msg), &l); err != nil {
		t.Fatal(err)
	}
	if l.Effort != "high" || len(l.Egress) != 1 || l.Egress[0] != "pkg.go.dev" || l.Web != "raw" || l.Limits["max_minutes"] != 30 {
		t.Fatalf("lock = %+v", l)
	}
	if got := gitOut(t, bare, "log", "-1", "--format=%B", "main"); got != msg {
		t.Fatalf("main commit message = %q, want the lock", got)
	}
	if yml := gitOut(t, bare, "show", "agent/dev/v1:agents/dev/agent.yml"); !strings.Contains(yml, "role: develop") {
		t.Fatalf("agent.yml lost role: %q", yml)
	}
	if p := gitOut(t, bare, "show", "agent/dev/v1:agents/dev/prompt.md"); p != "You are dev v2." {
		t.Fatalf("prompt.md = %q", p)
	}
}

func TestResolve_EgressMode_DefaultsToEnforceAndCarriesAudit(t *testing.T) {
	for yml, want := range map[string]string{"": "enforce", "egress_mode: audit\n": "audit", "egress_mode: off\n": ""} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "prompt.md"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "agent.yml"), []byte("harness: h\nmodel: m\neffort: e\n"+yml), 0o644); err != nil {
			t.Fatal(err)
		}
		l, err := resolve(dir, "dev")
		if (err != nil) != (want == "") || l.EgressMode != want {
			t.Fatalf("agent.yml %q: egress_mode = %q, err = %v; want %q", yml, l.EgressMode, err, want)
		}
	}
}

func TestResolve_Web_DefaultsToMarkdownAndCarriesRaw(t *testing.T) {
	for yml, want := range map[string]string{"": "markdown", "web: raw\n": "raw", "web: html\n": ""} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "prompt.md"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "agent.yml"), []byte("harness: h\nmodel: m\neffort: e\n"+yml), 0o644); err != nil {
			t.Fatal(err)
		}
		l, err := resolve(dir, "dev")
		if (err != nil) != (want == "") || l.Web != want {
			t.Fatalf("agent.yml %q: web = %q, err = %v; want %q", yml, l.Web, err, want)
		}
	}
}

func TestRelease_NoTools_LockListsNoneNotNull(t *testing.T) {
	bare := agentsRepo(t)
	d := &draft{Harness: "claude-code", Model: "claude-opus-5-5", Effort: "default", Tools: []string{}, Egress: []string{},
		Limits: map[string]float64{"max_cost_usd": 8, "max_minutes": 120}, Prompt: "You are dev."}
	if _, err := release(context.Background(), "", bare, "dev-copy", d); err != nil {
		t.Fatal(err)
	}
	msg := gitOut(t, bare, "tag", "--list", "--format=%(contents)", "agent/dev-copy/v1")
	if !strings.Contains(msg, `"tools": []`) || !strings.Contains(msg, `"egress": []`) {
		t.Fatalf("lock = %s, want tools and egress as empty lists", msg)
	}
}
