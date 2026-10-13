package verify

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/guard"
)

// maxGuardDiff caps the diff sent to the Worker's judge; the deterministic scan has already read every line.
const maxGuardDiff = 1 << 20

// Guard is a guard job on the push before..after to fork: guard.ScanPush's findings, the dependencies the push's
// lockfiles and manifests add, and its diff for the Worker's judge. A change's first head has no before: it is
// compared from its merge-base with target. A push whose before the fork no longer holds is read whole. A git error or unreadable lockfile fails the job.
func Guard(ctx context.Context, dir string, token api.Secret, fork, before, after, target string) api.Report {
	fail := func(err error) api.Report { return api.Report{Status: "failed", Detail: "guard: " + err.Error()} }
	// --mirror: a person's push sits under refs/for/*, which a plain bare clone leaves out.
	if out, err := gitauth.Command(ctx, string(token), "clone", "--quiet", "--mirror", "--", fork, dir).CombinedOutput(); err != nil {
		return fail(fmt.Errorf("git clone: %v\n%s", err, tail(out)))
	}
	git := func(args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
		return string(out), err
	}
	// A force push (cinder's own converge) leaves its before out of the fork, so there is nothing to compare from.
	// ponytail: the whole pushed history is scanned and diffed; compare from the target's tip once a guard job carries its remote.
	if _, err := git("cat-file", "-e", before+"^{commit}"); before != "" && err != nil {
		before = strings.Repeat("0", 40)
	}
	if before == "" && target != "" {
		if mb, err := git("merge-base", after, "refs/heads/"+target); err == nil {
			before = strings.TrimSpace(mb)
		}
	}
	if before == "" {
		before = strings.Repeat("0", 40)
	}
	found, err := guard.ScanPush(ctx, dir, before, after, "")
	if err != nil {
		return fail(err)
	}
	rep := api.Report{Status: "done"}
	for _, f := range found {
		rep.Findings = append(rep.Findings, api.Finding{Rule: f.Rule, File: f.Path, Line: f.Line})
	}
	// A new ref (all-zero before) is compared with the empty tree.
	base := before
	if strings.Trim(before, "0") == "" {
		if base, err = git("hash-object", "-t", "tree", "/dev/null"); err != nil {
			return fail(err)
		}
		base = strings.TrimSpace(base)
	}
	if rep.Diff, err = git("diff", "--no-color", "--no-ext-diff", base, after); err != nil {
		return fail(err)
	}
	rep.Diff = rep.Diff[:min(len(rep.Diff), maxGuardDiff)]
	// -z: "status\x00path\x00" per file.
	names, err := git("diff", "--name-status", "-z", "--no-renames", "--diff-filter=d", base, after)
	if err != nil {
		return fail(err)
	}
	f := strings.Split(strings.TrimSuffix(names, "\x00"), "\x00")
	// A package.json is read only when no npm lockfile changed, so one npm dependency isn't listed twice.
	npmLock := false
	for i := 1; i < len(f); i += 2 {
		npmLock = npmLock || lockfiles[filepath.Base(f[i])]
	}
	for i := 1; i < len(f); i += 2 {
		path := f[i]
		if _, ok := lockfiles[filepath.Base(path)]; !ok && (npmLock || filepath.Base(path) != "package.json") {
			continue
		}
		head, err := git("show", after+":"+path)
		if err != nil {
			return fail(err)
		}
		// A file the push adds has no base: every dependency in it is new.
		var was string
		if f[i-1] != "A" {
			if was, err = git("show", base+":"+path); err != nil {
				return fail(err)
			}
		}
		deps, err := guard.AddedDeps(path, []byte(was), []byte(head))
		if err != nil {
			return fail(err)
		}
		rep.Deps = append(rep.Deps, deps...)
	}
	return rep
}
