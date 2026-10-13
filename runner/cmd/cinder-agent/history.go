package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/gitauth"
)

// writeHistory commits files (path → content, from a history job's payload) as one commit and
// force-pushes it to ref on target; token writes the target. The ref belongs to one change, so a
// re-run after an expired lease replaces it.
func writeHistory(ctx context.Context, token, target, ref string, files map[string]string) error {
	dir, err := os.MkdirTemp("", "cinder-history-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	for name, content := range files {
		// Acceptance paths come from the API; never let one write outside the clone or into its .git (hooks run).
		if !filepath.IsLocal(name) || strings.Split(filepath.ToSlash(filepath.Clean(name)), "/")[0] == ".git" {
			return fmt.Errorf("history: bad path %q", name)
		}
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			return err
		}
	}
	for _, args := range [][]string{
		{"init", "--quiet"},
		{"add", "-A"},
		{"commit", "--quiet", "-m", "cinder: history for " + ref},
		{"push", "--quiet", "--force", target, "HEAD:" + ref},
	} {
		cmd := gitauth.Command(ctx, token, append([]string{"-C", dir, "-c", "core.autocrlf=false",
			"-c", "user.name=cinder-agent", "-c", "user.email=cinder-agent@cinder.invalid"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git %s: %w: %s", args[0], err, out)
		}
	}
	return nil
}
