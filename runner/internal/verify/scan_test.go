package verify

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestScan_SecretAlreadyOnMain_ProducesFinding(t *testing.T) {
	tmp := t.TempDir()
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main target; echo 'key = "AKIAABCDEFGHIJKLMNOP"' > target/config.js
git -C target add .; git -C target commit -qm secret; git -C target rev-parse HEAD`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	sarif := `{"runs":[{"results":[{"ruleId":"no-eval","locations":[{"physicalLocation":{"artifactLocation":{"uri":"config.js"},"region":{"startLine":1}}}]}]}]}`
	j := Job{Target: filepath.Join(tmp, "target"), Branch: "main", Head: strings.TrimSpace(string(out)), Check: "echo '" + sarif + "' > out.sarif; exit 1"}
	rep := Scan(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if rep.Status != "done" || len(rep.Secrets) != 1 || rep.Secrets[0].Rule != "aws_access_key_id" || rep.Secrets[0].Path != "config.js" {
		t.Fatalf("want the secret on main reported, got %+v", rep)
	}
	if len(rep.Findings) != 1 || rep.Findings[0].Rule != "no-eval" {
		t.Fatalf("want every SARIF result the check wrote, got %+v", rep.Findings)
	}
}

func TestScan_PackageJSONWithoutLockfile_ListsDependencies(t *testing.T) {
	tmp := t.TempDir()
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main target; echo '{"dependencies":{"react":"^19.1.0"},"devDependencies":{"vite":"~7.0.2"}}' > target/package.json
git -C target add .; git -C target commit -qm deps; git -C target rev-parse HEAD`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	j := Job{Target: filepath.Join(tmp, "target"), Branch: "main", Head: strings.TrimSpace(string(out))}
	rep := Scan(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	got := map[string]string{}
	for _, d := range rep.Deps {
		got[d.Name] = d.Version
	}
	if rep.Status != "done" || len(got) != 2 || got["react"] != "19.1.0" || got["vite"] != "7.0.2" {
		t.Fatalf("want react and vite from package.json, got %+v", rep)
	}
}

func TestScan_PnpmLock_ListsResolvedVersions(t *testing.T) {
	tmp := t.TempDir()
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main target; echo '{"dependencies":{"react":"^19.1.0"}}' > target/package.json
printf "lockfileVersion: '9.0'\npackages:\n  react@19.1.4:\n    resolution: {integrity: sha512-x}\n" > target/pnpm-lock.yaml
printf '# yarn lockfile v1\n\nleft-pad@^1.3.0:\n  version "1.3.0"\n' > target/yarn.lock
git -C target add .; git -C target commit -qm deps; git -C target rev-parse HEAD`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	j := Job{Target: filepath.Join(tmp, "target"), Branch: "main", Head: strings.TrimSpace(string(out))}
	rep := Scan(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	got := map[string]string{}
	for _, d := range rep.Deps {
		got[d.Name] = d.Version
	}
	if rep.Status != "done" || len(got) != 2 || got["react"] != "19.1.4" || got["left-pad"] != "1.3.0" {
		t.Fatalf("want the resolved versions from pnpm-lock.yaml and yarn.lock, got %+v", rep)
	}
}
