package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// unitValue returns the value of key= in a systemd unit, with %h expanded to home.
func unitValue(t *testing.T, unit, key, home string) string {
	t.Helper()
	for line := range strings.Lines(unit) {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), key+"="); ok {
			return strings.ReplaceAll(v, "%h", home)
		}
	}
	t.Fatalf("unit has no %s=", key)
	return ""
}

// Follows runner/README.md against a fake Worker. systemd's part (step 4) is done
// by hand: run the unit's ExecStart with only the variables from its EnvironmentFile.
func TestReadme_FreshMachine_RegistersRunnerAndClaimsJob(t *testing.T) {
	home := t.TempDir()
	var mu sync.Mutex
	var claimAuth []string
	reported := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/runners":
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"id":"run1","token":"runner-secret"}`)
		case "/api/work/claim":
			claimAuth = append(claimAuth, r.Header.Get("Authorization"))
			if len(claimAuth) > 1 {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			fmt.Fprint(w, `{"token":"git-secret","job":{"id":"j1","repo_id":"r1","kind":"develop","change_id":"c1","status":"claimed",`+
				`"runner_id":"run1","lease_expires_at":"2026-10-04T12:00:00Z","created_at":"2026-10-04T10:00:00Z"}}`)
		case "/api/work/jobs/j1/report":
			reported <- struct{}{}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// Step 1: make runners and install to ~/.local/bin (the cinder CLI too, for step 2).
	bin := filepath.Join(home, ".local", "bin")
	if out, err := exec.Command("make", "-C", "../../..", "runners").CombinedOutput(); err != nil {
		t.Fatalf("make runners: %v\n%s", err, out)
	}
	build := exec.Command("go", "build", "-o", bin+"/", "../cinder")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	for _, b := range []string{"cinder-agent", "cinder-verify"} {
		if out, err := exec.Command("install", "-D", "-t", bin, "../../../bin/"+b).CombinedOutput(); err != nil {
			t.Fatalf("install %s: %v\n%s", b, err, out)
		}
	}

	// Step 2: register the agent's runner.
	reg := exec.Command(filepath.Join(bin, "cinder"), "runner", "register", "lab-agent", "--kinds", "develop")
	reg.Env = append(os.Environ(), "CINDER_URL="+srv.URL, "CINDER_TOKEN=owner")
	out, err := reg.Output()
	var runner struct{ Token string }
	if err != nil || json.Unmarshal(out, &runner) != nil || runner.Token == "" {
		t.Fatalf("register: %v: %s", err, out)
	}

	// Step 3: the env file from the template, with the URL and token filled in.
	tmpl, err := os.ReadFile("../../deploy/runner.env.example")
	if err != nil {
		t.Fatal(err)
	}
	var env []string
	for line := range strings.Lines(string(tmpl)) {
		switch k, _, _ := strings.Cut(strings.TrimSpace(line), "="); k {
		case "CINDER_URL":
			line = k + "=" + srv.URL
		case "CINDER_RUNNER_TOKEN":
			line = k + "=" + runner.Token
		}
		env = append(env, strings.TrimSpace(line))
	}
	envFile := filepath.Join(home, ".config", "cinder", "agent.env")
	if err := os.MkdirAll(filepath.Dir(envFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envFile, []byte(strings.Join(env, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}

	// Step 4: start the unit as systemd would.
	unit, err := os.ReadFile("../../deploy/cinder-agent.service")
	if err != nil {
		t.Fatal(err)
	}
	if got := unitValue(t, string(unit), "EnvironmentFile", home); got != envFile {
		t.Fatalf("EnvironmentFile = %s, README installs it at %s", got, envFile)
	}
	agent := exec.Command(unitValue(t, string(unit), "ExecStart", home))
	agent.Env = []string{}
	for _, l := range env {
		if l != "" && !strings.HasPrefix(l, "#") {
			agent.Env = append(agent.Env, l)
		}
	}
	if err := agent.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { agent.Process.Kill(); agent.Wait() }()

	select {
	case <-reported:
	case <-time.After(30 * time.Second):
		t.Fatal("agent never reported a claimed job")
	}
	mu.Lock()
	defer mu.Unlock()
	if claimAuth[0] != "Bearer runner-secret" {
		t.Fatalf("claim Authorization = %q, want the registered runner token", claimAuth[0])
	}
}
