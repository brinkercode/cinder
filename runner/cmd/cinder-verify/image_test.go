package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

var toolchainVersionCmds = []string{"node --version", "npm --version", "go version", "python --version", "pip --version", "uv --version", "rustc --version", "cargo --version", "dotnet --version", "terraform version", "helm version", "git --version", "make --version"}

// finalStage is the Dockerfile's last stage: what the image ships, without the build stages before it.
func finalStage(t *testing.T, name string) string {
	df, err := os.ReadFile("../../" + name)
	if err != nil {
		t.Fatal(err)
	}
	s := string(df)
	return s[strings.LastIndex(s, "\nFROM "):]
}

// The seven stack toolchains, each by a path or command only its install mentions.
var stackToolchains = map[string]string{"node": "node", "go": "/usr/local/go", "python": "FROM python:", "rust": "/usr/local/cargo",
	"dotnet": "/usr/share/dotnet", "terraform": "/bin/terraform", "helm": "/usr/bin/helm"}

func TestDockerfiles_SlimInstallsOnlyNodeAndGit_FullInstallsAllSeven(t *testing.T) {
	slim, full := finalStage(t, "Dockerfile"), finalStage(t, "Dockerfile.full")
	for name, marker := range stackToolchains {
		if got := strings.Contains(slim, marker); got != (name == "node") {
			t.Errorf("runner/Dockerfile installs %s: %v, want %v", name, got, name == "node")
		}
		if !strings.Contains(full, marker) {
			t.Errorf("runner/Dockerfile.full does not install %s", name)
		}
	}
	for _, df := range []string{slim, full} {
		if !strings.Contains(df, " git ") {
			t.Errorf("an image does not install git:\n%s", df)
		}
	}
}

// docker build runs the Dockerfile's smoke RUN step, so a missing or broken toolchain fails the image build.
func TestDockerfile_SmokeStepRunsEveryToolchainVersion(t *testing.T) {
	df, err := os.ReadFile("../../Dockerfile.full")
	if err != nil {
		t.Fatal(err)
	}
	var smoke string
	for _, line := range strings.Split(string(df), "\n") {
		if strings.HasPrefix(line, "RUN node --version") {
			smoke = line + " &&"
		}
	}
	for _, cmd := range toolchainVersionCmds {
		if !strings.Contains(smoke, cmd+" &&") {
			t.Errorf("runner/Dockerfile.full smoke step does not run %q", cmd)
		}
	}
}

// Builds the slim image only: the full one's multi-GB build outlasts go test's timeout in CI. Its toolchains are checked
// by its smoke RUN step (TestDockerfile_SmokeStepRunsEveryToolchainVersion), which fails the release build on a break.
// A cold build takes minutes, so it runs only when CINDER_IMAGE_TEST=1 (make check-image), not in make check-go.
func TestImage_SlimImageToolsAnswerVersionCommands(t *testing.T) {
	if os.Getenv("CINDER_IMAGE_TEST") != "1" {
		t.Skip("set CINDER_IMAGE_TEST=1 (make check-image) to build runner/Dockerfile")
	}
	var rt string
	for _, name := range []string{"docker", "podman"} {
		if _, err := exec.LookPath(name); err == nil {
			rt = name
			break
		}
	}
	if rt == "" {
		t.Skip("no container runtime (docker or podman) on PATH: can't build runner/Dockerfile")
	}
	const img = "cinder-runner-slim-test"
	if out, err := exec.Command(rt, "build", "-t", img, "../..").CombinedOutput(); err != nil {
		t.Fatalf("%s build: %v\n%s", rt, err, out)
	}
	for _, cmd := range []string{"node --version", "npm --version", "git --version", "make --version", "command -v cinder-verify cinder-agent"} {
		if out, err := exec.Command(rt, "run", "--rm", "--entrypoint", "sh", img, "-c", cmd).CombinedOutput(); err != nil {
			t.Errorf("%s in the image: %v\n%s", cmd, err, out)
		}
	}
}

func TestImage_SkippedUnlessRequested(t *testing.T) {
	dir := t.TempDir()
	// A docker that fails: reaching it means the build was attempted.
	if err := os.WriteFile(dir+"/docker", []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("CINDER_IMAGE_TEST", "")
	var skipped bool
	t.Run("image", func(t *testing.T) {
		defer func() { skipped = t.Skipped() }()
		TestImage_SlimImageToolsAnswerVersionCommands(t)
	})
	if !skipped {
		t.Error("the image build ran without CINDER_IMAGE_TEST=1")
	}
}
