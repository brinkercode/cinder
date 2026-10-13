package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// capture runs the CLI against a fake API and returns the request it received.
func capture(t *testing.T, args ...string) (*http.Request, map[string]any) {
	t.Helper()
	var req *http.Request
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req = r
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &body); len(b) > 0 && err != nil {
			t.Errorf("body is not JSON: %s", b)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	if err := run(args, srv.URL, "owner-token", io.Discard); err != nil {
		t.Fatal(err)
	}
	return req, body
}

func TestChangeNew_SendsIntentUnchanged(t *testing.T) {
	intent := "  Add a \"dark mode\" toggle;\n keep it off by default — ünïcode & <tags>  "
	req, body := capture(t, "change", "new", "my-repo", intent, "--target", "release/1")
	if req.Method != http.MethodPost || req.URL.Path != "/api/repos/my-repo/changes" ||
		req.Header.Get("Authorization") != "Bearer owner-token" {
		t.Fatalf("got %s %s auth=%q", req.Method, req.URL.Path, req.Header.Get("Authorization"))
	}
	if body["intent"] != intent || body["target_branch"] != "release/1" {
		t.Fatalf("intent %q, target %v", body["intent"], body["target_branch"])
	}
}

func TestChangeNew_AcceptanceUploadsFilesWithRelativePaths(t *testing.T) {
	dir := t.TempDir()
	for p, c := range map[string]string{"a.test.js": "it(1)", "sub/b_test.go": "package b"} {
		if err := os.MkdirAll(filepath.Join(dir, filepath.Dir(p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, p), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_, body := capture(t, "change", "new", "my-repo", "intent", "--acceptance", dir)
	var got []string
	for _, f := range body["acceptance"].([]any) {
		m := f.(map[string]any)
		got = append(got, m["path"].(string)+"="+m["content"].(string))
	}
	slices.Sort(got)
	if want := []string{"a.test.js=it(1)", "sub/b_test.go=package b"}; !slices.Equal(got, want) {
		t.Fatalf("acceptance files %v, want %v", got, want)
	}
}

func TestChangeDraft_NewSendsDraftAndReadyPostsReady(t *testing.T) {
	if _, body := capture(t, "change", "new", "my-repo", "intent", "--draft"); body["draft"] != true {
		t.Fatalf("draft %v, want true", body["draft"])
	}
	if req, _ := capture(t, "change", "ready", "c1"); req.Method != http.MethodPost || req.URL.Path != "/api/changes/c1/ready" {
		t.Fatalf("got %s %s", req.Method, req.URL.Path)
	}
}

func TestChangeRetry_PostsRetry(t *testing.T) {
	if req, _ := capture(t, "change", "retry", "c1"); req.Method != http.MethodPost || req.URL.Path != "/api/changes/c1/retry" {
		t.Fatalf("got %s %s", req.Method, req.URL.Path)
	}
}

func TestCLI_AccessVarsSet_RequestCarriesBothHeaders(t *testing.T) {
	t.Setenv("CINDER_ACCESS_CLIENT_ID", "id.access")
	t.Setenv("CINDER_ACCESS_CLIENT_SECRET", "s3cret")
	req, _ := capture(t, "change", "new", "my-repo", "intent")
	if req.Header.Get("CF-Access-Client-Id") != "id.access" || req.Header.Get("CF-Access-Client-Secret") != "s3cret" ||
		req.Header.Get("Authorization") != "Bearer owner-token" {
		t.Fatalf("headers %v", req.Header)
	}
}

func TestRepoCredentials_PostsGitCredentials(t *testing.T) {
	if req, _ := capture(t, "repo", "credentials", "pulse"); req.Method != http.MethodPost || req.URL.Path != "/api/repos/pulse/git-credentials" {
		t.Fatalf("got %s %s", req.Method, req.URL.Path)
	}
}

func TestEnvRollback_CallsTheRollbackAPI(t *testing.T) {
	t.Setenv("CINDER_REPO", "pulse")
	req, body := capture(t, "env", "rollback", "production", "--reason", "500s after deploy")
	if req.Method != http.MethodPost || req.URL.Path != "/api/repos/pulse/environments/production/rollback" ||
		req.Header.Get("Authorization") != "Bearer owner-token" || body["reason"] != "500s after deploy" {
		t.Fatalf("got %s %s auth=%q body=%v", req.Method, req.URL.Path, req.Header.Get("Authorization"), body)
	}
}

func TestRepoAirlock_CLISetsTheAirlock(t *testing.T) {
	for arg, want := range map[string]bool{"on": true, "off": false} {
		req, body := capture(t, "repo", "airlock", "pulse", arg)
		if req.Method != http.MethodPut || req.URL.Path != "/api/repos/pulse/airlock" || body["on"] != want {
			t.Fatalf("airlock %s: got %s %s body=%v", arg, req.Method, req.URL.Path, body)
		}
	}
	if err := run([]string{"repo", "airlock", "pulse", "maybe"}, "http://x", "t", io.Discard); err == nil {
		t.Fatal("airlock maybe: want usage error")
	}
}

func TestRepoJudgeSet_PutsBackendAndModel(t *testing.T) {
	req, body := capture(t, "repo", "judge", "set", "pulse", "risk", "--backend", "systemone-http", "--model", "s1@2", "--base-url", "http://s1.lan")
	if req.Method != http.MethodPut || req.URL.Path != "/api/repos/pulse/judges/risk" ||
		body["backend"] != "systemone-http" || body["model_version"] != "s1@2" || body["base_url"] != "http://s1.lan" {
		t.Fatalf("got %s %s body=%v", req.Method, req.URL.Path, body)
	}
}

func TestVerifyCommit_TamperedCommitFails(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	repo, key := t.TempDir(), filepath.Join(t.TempDir(), "key")
	git := func(stdin string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return string(out)
	}
	if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v: %s", err, out)
	}
	git("", "init", "--quiet")
	git("", "-c", "gpg.format=ssh", "-c", "user.signingKey="+key, "commit", "--quiet", "--allow-empty", "-S", "-m", "cinder: merge change chg_1")
	signed := strings.TrimSpace(git("", "rev-parse", "HEAD"))
	tampered := strings.TrimSpace(git(strings.Replace(git("", "cat-file", "commit", signed), "chg_1", "chg_2", 1),
		"hash-object", "-t", "commit", "-w", "--stdin"))
	t.Chdir(repo)

	verify := func(sha string) error {
		return run([]string{"verify-commit", sha, "--key", key + ".pub"}, "", "", io.Discard)
	}
	if err := verify(signed); err != nil {
		t.Fatalf("signed commit: %v", err)
	}
	if err := verify(tampered); err == nil {
		t.Fatal("tampered commit verified")
	}
}

func TestRegister_PoolToken_SentInBody(t *testing.T) {
	req, body := capture(t, "runner", "register", "lab-1", "--kinds", "verify", "--pool-token", "pt-abc")
	if req.URL.Path != "/api/runners" || body["pool_token"] != "pt-abc" || body["name"] != "lab-1" {
		t.Fatalf("got %s %v", req.URL.Path, body)
	}
	// From CINDER_POOL_TOKEN alone, with no CINDER_TOKEN and so no Authorization header.
	t.Setenv("CINDER_POOL_TOKEN", "pt-env")
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	if err := run([]string{"runner", "register", "lab-2", "--kinds", "verify"}, srv.URL, "", io.Discard); err != nil {
		t.Fatal(err)
	}
	if body["pool_token"] != "pt-env" || auth != "" {
		t.Fatalf("body %v, auth %q", body, auth)
	}
}

func TestRevoke_UsesWorkersRoute(t *testing.T) {
	req, _ := capture(t, "runner", "revoke", "r_1")
	if req.Method != http.MethodDelete || req.URL.Path != "/api/workers/r_1" {
		t.Fatalf("got %s %s", req.Method, req.URL.Path)
	}
}
