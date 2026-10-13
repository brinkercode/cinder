package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/decl"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/mergeprobe"
)

// converge rebases fork onto branch of target with cinder's merge drivers and force-pushes
// the fork. token writes the fork, readToken reads the target. A merge-tree probe runs first:
// a conflict is returned as the report's conflict payload, without rebasing or pushing.
func converge(ctx context.Context, token, readToken, fork, target, branch string) (string, *api.Conflict, error) {
	dir, err := os.MkdirTemp("", "cinder-converge-")
	if err != nil {
		return "", nil, err
	}
	defer os.RemoveAll(dir)
	git := func(tok string, args ...string) (string, error) {
		cmd := gitauth.Command(ctx, tok, append([]string{"-C", dir, "-c", "user.name=cinder-agent", "-c", "user.email=cinder-agent@cinder.invalid"}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %w: %s", args[0], err, out)
		}
		return strings.TrimSpace(string(out)), nil
	}
	if _, err := git(token, "clone", "--quiet", "--branch", branch, fork, "."); err != nil {
		return "", nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return "", nil, err
	}
	if err := decl.InstallDriver(dir, filepath.Join(filepath.Dir(exe), "cinder-verify")); err != nil {
		return "", nil, err
	}
	if _, err := git(readToken, "fetch", "--quiet", target, branch); err != nil {
		return "", nil, err
	}
	probe, err := mergeprobe.Probe(dir, "", "HEAD", "FETCH_HEAD")
	if err != nil {
		return "", nil, err
	}
	if !probe.Clean {
		c := &api.Conflict{Hunks: probe.Files}
		for _, f := range probe.Files {
			c.Files = append(c.Files, f.Path)
		}
		return "", c, nil
	}
	if _, err := git("", "rebase", "--quiet", "FETCH_HEAD"); err != nil {
		return "", nil, fmt.Errorf("converge conflict: %w", err)
	}
	if _, err := git(token, "push", "--quiet", "--force-with-lease", "origin", "HEAD:"+branch); err != nil {
		return "", nil, err
	}
	head, err := git("", "rev-parse", "HEAD")
	return head, nil, err
}
