package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
)

// flowEgress runs a one-step flow whose step fetches a local HTTPS "registry" by the name localhost, under pool egress
// e, and returns the job's report and whether the registry was reached.
func flowEgress(t *testing.T, e api.PoolEgress) (api.Report, bool) {
	t.Helper()
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c"}} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	sha, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	var reached atomic.Bool
	registry := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer registry.Close()
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer worker.Close()
	url := strings.Replace(registry.URL, "127.0.0.1", "localhost", 1)
	payload, _ := json.Marshal(map[string]any{"sha": strings.TrimSpace(string(sha)), "steps": []map[string]any{{"name": "fetch", "run": "curl -skf " + url}}})
	c := &api.Claim{Job: api.Job{ID: "j1"}, TargetRemote: repo, Payload: payload, Egress: e}
	return runFlow(context.Background(), &api.Client{BaseURL: worker.URL, Token: "t"}, c), reached.Load()
}

func TestFlowEgress_None_BlocksRegistry(t *testing.T) {
	r, reached := flowEgress(t, api.PoolEgress{Mode: "none", Allow: []string{"localhost"}})
	if r.Status != "failed" || reached || r.Egress == nil || r.Egress.Denied["localhost"] == 0 {
		t.Fatalf("none must refuse the registry and report it denied: reached=%v report=%+v egress=%+v", reached, r, r.Egress)
	}
}

func TestFlowEgress_AllowList_AllowsListedRegistry(t *testing.T) {
	r, reached := flowEgress(t, api.PoolEgress{Mode: "allowlist", Allow: []string{"localhost"}})
	if r.Status != "done" || !reached || r.Egress == nil || r.Egress.Allowed["localhost"] == 0 {
		t.Fatalf("a listed registry must be reached and reported allowed: reached=%v report=%+v egress=%+v", reached, r, r.Egress)
	}
	// An unlisted one is refused.
	if r, reached := flowEgress(t, api.PoolEgress{Mode: "allowlist", Allow: []string{"registry.npmjs.org"}}); r.Status != "failed" || reached {
		t.Fatalf("an unlisted registry must be refused: reached=%v report=%+v", reached, r)
	}
}

func TestFlowEgress_Open_RecordsWouldDeny(t *testing.T) {
	r, reached := flowEgress(t, api.PoolEgress{Mode: "open", Allow: []string{"registry.npmjs.org"}})
	if r.Status != "done" || !reached || r.Egress == nil || r.Egress.WouldDeny["localhost"] == 0 || len(r.Egress.Denied) != 0 {
		t.Fatalf("open must let the registry through and record it as would-deny: reached=%v report=%+v egress=%+v", reached, r, r.Egress)
	}
}
