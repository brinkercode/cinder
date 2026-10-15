package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
)

func TestEntrypoint_FlowAndDevelopClaims_RunTheirKindsHandler(t *testing.T) {
	df, err := os.ReadFile("../../Dockerfile")
	if err != nil || !strings.Contains(string(df), `ENTRYPOINT ["cinder-verify"]`) {
		t.Fatalf("runner/Dockerfile entrypoint is not cinder-verify (err %v)", err)
	}
	// The image puts cinder-agent next to cinder-verify on PATH.
	bin := t.TempDir()
	if out, err := exec.Command("go", "build", "-o", bin, "../cinder-agent").CombinedOutput(); err != nil {
		t.Fatalf("go build cinder-agent: %v\n%s", err, out)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	fork := filepath.Join(t.TempDir(), "fork.git")
	if out, err := exec.Command("git", "init", "--quiet", "--bare", fork).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	entry := dispatch(&api.Client{BaseURL: "http://127.0.0.1:1", Token: "t"})
	for kind, want := range map[string]string{"flow": "flow payload needs sha and steps", "develop": "target main has no commits"} {
		rep := entry(context.Background(), &api.Claim{Job: api.Job{ID: "j1", Kind: kind}, ForkRemote: fork, Change: &api.Change{ID: "c1", TargetBranch: "main"}})
		if strings.Contains(rep.Detail, "no handler") || !strings.Contains(rep.Detail, want) {
			t.Errorf("%s claim: report %+v, want its handler's %q", kind, rep, want)
		}
	}
}

func TestRunAgent_RunnerTokenUnsetFromEnv_StillReachesCinderAgent(t *testing.T) {
	bin := t.TempDir()
	agent := "#!/bin/sh\nprintf '{\"status\":\"done\",\"detail\":\"%s\"}' \"$CINDER_RUNNER_TOKEN\"\n"
	if err := os.WriteFile(filepath.Join(bin, "cinder-agent"), []byte(agent), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CINDER_RUNNER_TOKEN", "")
	os.Unsetenv("CINDER_RUNNER_TOKEN") // as main leaves it; t.Setenv restores it
	runnerToken = "runner-secret"
	t.Cleanup(func() { runnerToken = "" })
	if rep := run(context.Background(), &api.Claim{Job: api.Job{Kind: "develop"}}); rep.Detail != "runner-secret" {
		t.Fatalf("report %+v, want cinder-agent to get the runner token", rep)
	}
}
