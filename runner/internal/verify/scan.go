package verify

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/guard"
)

// lockfiles are the lockfiles guard.AddedDeps reads; true marks an npm one, which replaces package.json in the scan.
var lockfiles = map[string]bool{"package-lock.json": true, "pnpm-lock.yaml": true, "yarn.lock": true,
	"go.mod": false, "Cargo.lock": false, "poetry.lock": false, "requirements.txt": false}

// Scan is a full scan of commit j.Head on j.Target's branch j.Branch: every secret in its tracked files, every
// dependency in its lockfiles and every SARIF result j.Check writes. The check failing doesn't fail the scan; a
// timeout, git error or unreadable SARIF or lockfile does.
func Scan(ctx context.Context, dir string, token api.Secret, j Job) api.Report {
	// The target is its own fork, so run checks out j.Head; "true" stands in for a repo with no check.
	j.Fork, j.Check = j.Target, cmp.Or(j.Check, "true")
	rep, checkFailed := run(ctx, dir, token, j)
	if rep.Status == "failed" && !checkFailed {
		return rep
	}
	rep.Status = "done"
	fail := func(err error) api.Report {
		return api.Report{Status: "failed", Detail: fmt.Sprintf("scan: %v\n%s", err, rep.Detail)}
	}
	var err error
	if rep.Findings, err = findings(ctx, dir, ""); err != nil {
		return fail(err)
	}
	files, err := exec.CommandContext(ctx, "git", "-C", dir, "ls-files", "-z").Output()
	if err != nil {
		return fail(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return fail(err)
	}
	defer root.Close()
	// A repo with no lockfile lists its package.json dependencies instead, so its inventory never empties.
	hasLock, manifests := false, map[string][]byte{}
	for _, f := range strings.Split(strings.TrimSuffix(string(files), "\x00"), "\x00") {
		// Symlinks and submodules are skipped: a symlink must never read a file outside the clone.
		if st, err := root.Lstat(f); f == "" || err != nil || !st.Mode().IsRegular() {
			continue
		}
		b, err := root.ReadFile(f)
		if err != nil {
			return fail(err)
		}
		n := filepath.Base(f)
		if n == "package.json" {
			manifests[f] = b
		}
		if npm, ok := lockfiles[n]; ok {
			hasLock = hasLock || npm
			deps, err := guard.AddedDeps(f, nil, b)
			if err != nil {
				return fail(err)
			}
			rep.Deps = append(rep.Deps, deps...)
		}
		if !guard.LooksBinary(string(b)) {
			rep.Secrets = append(rep.Secrets, guard.Scan(f, string(b))...)
		}
	}
	for f, b := range manifests {
		if !hasLock {
			deps, err := guard.AddedDeps(f, nil, b)
			if err != nil {
				return fail(err)
			}
			rep.Deps = append(rep.Deps, deps...)
		}
	}
	return rep
}
