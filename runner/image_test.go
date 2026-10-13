package runner

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// smokeTools returns the command of each `&&` step in the RUN that follows the Dockerfile's "# Smoke test" comment: the
// tools the image is proven to install, since the build fails unless each answers.
func smokeTools(t *testing.T, path string) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\\\n", " "), "\n")
	for i, l := range lines {
		if strings.HasPrefix(l, "# Smoke test") && i+1 < len(lines) {
			tools := map[string]bool{}
			for _, step := range strings.Split(strings.TrimPrefix(lines[i+1], "RUN "), "&&") {
				tools[strings.Fields(step)[0]] = true
			}
			return tools
		}
	}
	t.Fatalf("%s: no smoke test RUN", path)
	return nil
}

// A managed pool's develop job runs the claude CLI (internal/harness); an image without it fails develop in seconds.
func TestDockerfiles_InstallClaudeCLI_DevelopRunsOnManagedPools(t *testing.T) {
	for _, path := range []string{"Dockerfile", "Dockerfile.full"} {
		if !smokeTools(t, path)["claude"] {
			t.Errorf("%s: claude is not installed, so develop fails at once", path)
		}
	}
}

// The seeded agents run on Workers AI through the opencode harness; an image without it fails their develop at once.
func TestDockerfiles_InstallOpencode_WorkersAIAgentsRunOnManagedPools(t *testing.T) {
	for _, path := range []string{"Dockerfile", "Dockerfile.full"} {
		if !smokeTools(t, path)["opencode"] {
			t.Errorf("%s: opencode is not installed, so a Workers AI agent's develop fails at once", path)
		}
	}
}

func TestDockerfileFull_InstallsEveryBakedStack_SlimOnlyNodeAndGit(t *testing.T) {
	full := smokeTools(t, "Dockerfile.full")
	for _, tool := range []string{"node", "python", "go", "rustup", "dotnet", "java", "mvn", "gradle", "php", "composer", "ruby", "terraform", "helm", "kubectl", "gh", "jq", "yq", "git-lfs"} {
		if !full[tool] {
			t.Errorf("Dockerfile.full: %s is not installed", tool)
		}
	}
	allowed := map[string]bool{"node": true, "npm": true, "git": true, "make": true, "claude": true, "opencode": true}
	for tool := range smokeTools(t, "Dockerfile") {
		if !allowed[tool] {
			t.Errorf("Dockerfile: %s installed beyond node and git", tool)
		}
	}
}

// A flow builds its image as the dry run; the managed pools have no Docker daemon, so the full image bakes buildah.
func TestDockerfileFull_InstallsDaemonlessImageBuilder(t *testing.T) {
	if !smokeTools(t, "Dockerfile.full")["buildah"] {
		t.Error("Dockerfile.full: buildah does not answer its version command")
	}
	b, err := os.ReadFile("Dockerfile.full")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, "ARG BUILDAH_VERSION=") || !strings.Contains(s, "buildah=${BUILDAH_VERSION}") {
		t.Error("Dockerfile.full: buildah is not installed at a pinned version")
	}
	if !regexp.MustCompile(`ENV CINDER_BAKED="[^"]*\bbuildah=`).MatchString(s) {
		t.Error("Dockerfile.full: CINDER_BAKED does not name buildah")
	}
}

func TestDockerfileFull_ImageBuilderNeedsNoDaemonOrPrivilege(t *testing.T) {
	image, err := os.ReadFile("Dockerfile.full")
	if err != nil {
		t.Fatal(err)
	}
	pools, err := os.ReadFile("../worker/wrangler.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(image), "ENV STORAGE_DRIVER=vfs BUILDAH_ISOLATION=chroot") {
		t.Error("Dockerfile.full: buildah does not default to vfs storage and chroot isolation, which need no privilege")
	}
	for name, s := range map[string]string{"Dockerfile.full": string(image), "wrangler.jsonc": string(pools)} {
		for _, banned := range []string{"dockerd", "docker.sock", "privileged"} {
			if strings.Contains(s, banned) {
				t.Errorf("%s: contains %q", name, banned)
			}
		}
	}
}

// The image is built only when its Dockerfiles change, so CI must build it then: a broken image otherwise ships unseen.
func TestCIWorkflow_ImageJobRunsOnDockerfileChanges(t *testing.T) {
	b, err := os.ReadFile("../.github/workflows/ci.yml")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	i := strings.Index(s, "\n  image:\n")
	if i < 0 {
		t.Fatal("ci.yml: no image job")
	}
	job := s[i+1:]
	if j := regexp.MustCompile(`\n  \w+:\n`).FindStringIndex(job[1:]); j != nil {
		job = job[:j[0]+1]
	}
	for _, want := range []string{"runner/Dockerfile*", "make check-image", "docker image inspect", "docker run"} {
		if !strings.Contains(job, want) {
			t.Errorf("ci.yml image job does not contain %q", want)
		}
	}
}

// A PR that changes runner/Dockerfile.full builds it, so a broken full image is found before a release.
func TestCIWorkflow_FullRunnerImageJob(t *testing.T) {
	b, err := os.ReadFile("../.github/workflows/ci.yml")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^\s+run: docker build -f runner/Dockerfile\.full\b`).Match(b) {
		t.Fatal("ci.yml has no job that builds runner/Dockerfile.full")
	}
}

// CI must run the seed repos' own checks, or a broken seed repo passes CI.
func TestCIWorkflow_CheckSeedStep(t *testing.T) {
	b, err := os.ReadFile("../.github/workflows/ci.yml")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^\s+- run: make .*\bcheck-seed\b`).Match(b) {
		t.Fatal("ci.yml runs no make target that includes check-seed")
	}
}

// A release deploys and never seeds or runs e2e: live repo data changes only by hand (reseed, make seed).
func TestReleaseWorkflow_DeploysWithoutSeeding(t *testing.T) {
	b, err := os.ReadFile("../.github/workflows/release.yml")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, banned := range []string{"seed/seed.mjs", "- name: seed", "- name: budgets", "e2e-live SPECS"} {
		if strings.Contains(s, banned) {
			t.Errorf("release.yml contains %q", banned)
		}
	}
	health, warm, tag := strings.Index(s, "- name: health"), strings.Index(s, "- name: warm"), strings.Index(s, "- name: tag")
	if health < 0 || warm < 0 || tag < 0 || !(health < warm && warm < tag) {
		t.Fatalf("release.yml must run health, then warm, then tag (got %d, %d, %d)", health, warm, tag)
	}
}

// CI runs the Worker suite as 3 parallel shards, and the required `ts` check still fails unless every shard and the web job pass.
func TestCIWorkflow_ShardsTheWorkerSuite(t *testing.T) {
	b, err := os.ReadFile("../.github/workflows/ci.yml")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, "vitest run --shard=${{ matrix.shard }}/3") || !strings.Contains(s, "shard: [1, 2, 3]") {
		t.Error("ci.yml does not run the Worker vitest suite as shards 1..3 of 3")
	}
	if !regexp.MustCompile(`(?m)^  ts:\n    needs: \[worker, web\]\n    if: always\(\)`).MatchString(s) {
		t.Error("ci.yml has no ts job that needs the worker shards and web, whatever their result")
	}
}

// A release rolls the runner containers only when runner/ changed since the last release tag.
func TestReleaseWorkflow_SkipsImagesWhenRunnerUnchanged(t *testing.T) {
	b, err := os.ReadFile("../.github/workflows/release.yml")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{"git describe --tags --abbrev=0 --match 'release-*'", `git diff --quiet "$last" HEAD -- runner`, "containers=none", "deploy --containers-rollout ${{ steps.kind.outputs.containers }}"} {
		if !strings.Contains(s, want) {
			t.Errorf("release.yml does not contain %q", want)
		}
	}
}
