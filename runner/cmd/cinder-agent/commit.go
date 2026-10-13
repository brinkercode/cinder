package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/decl"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

// commitEdit writes content to path on branch of fork (a commit job's payload: a person's in-browser
// edit or an applied suggestion) as one commit and pushes it; token writes the fork. A non-empty thread is
// named in a Cinder-Thread trailer. Returns the symbols the commit wrote and read.
func commitEdit(ctx context.Context, token, fork, branch, path, content, thread string) ([]symbols.Write, []string, error) {
	// The path comes from the browser; never let it write outside the clone or into its .git (hooks run).
	if !filepath.IsLocal(path) || strings.Split(filepath.ToSlash(filepath.Clean(path)), "/")[0] == ".git" {
		return nil, nil, fmt.Errorf("commit: bad path %q", path)
	}
	dir, err := os.MkdirTemp("", "cinder-commit-")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(dir)
	git := func(args ...string) error {
		cmd := gitauth.Command(ctx, token, append([]string{"-C", dir, "-c", "core.autocrlf=false",
			"-c", "user.name=cinder-agent", "-c", "user.email=cinder-agent@cinder.invalid"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git %s: %w: %s", args[0], err, out)
		}
		return nil
	}
	if err := git("clone", "--quiet", "--branch", branch, fork, "."); err != nil {
		return nil, nil, err
	}
	p := filepath.Join(dir, path)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		return nil, nil, err
	}
	msg := "cinder: edit " + path
	if thread != "" {
		msg += "\n\nCinder-Thread: " + thread
	}
	for _, args := range [][]string{{"add", "--", path}, {"commit", "--quiet", "-m", msg}} {
		if err := git(args...); err != nil {
			return nil, nil, err
		}
	}
	diff, err := exec.CommandContext(ctx, "git", "-C", dir, "diff", "-U0", "--no-renames", "HEAD~1", "HEAD").Output()
	if err != nil {
		return nil, nil, fmt.Errorf("git diff: %w", err)
	}
	all, err := symbols.Index(dir)
	if err != nil {
		return nil, nil, err
	}
	ch, err := symbols.Diff(string(diff), func(p string) []decl.Symbol {
		src, err := exec.CommandContext(ctx, "git", "-C", dir, "show", "HEAD~1:"+p).Output()
		if err != nil { // not in the parent: an added file
			return nil
		}
		return symbols.File(p, src)
	}, symbols.ByPath(all))
	if err != nil {
		return nil, nil, err
	}
	if err := git("push", "--quiet", "origin", "HEAD:"+branch); err != nil {
		return nil, nil, err
	}
	return ch.Writes, ch.Reads, nil
}
