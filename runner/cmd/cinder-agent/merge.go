package main

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/owners"
)

// landing is one change a merge job lands: its key and title (the merge commit's subject), its fork, its head (the commit its verify checked), a token that reads the
// fork, the tree its verify checked and the target sha that verify merged onto.
type landing struct {
	Change string     `json:"change_id"`
	Key    string     `json:"key"`
	Title  string     `json:"title"`
	Head   string     `json:"head_sha"`
	Remote string     `json:"remote"`
	Token  api.Secret `json:"token"`
	Tree   string     `json:"tree"`
	Base   string     `json:"base"`
}

// merge lands each change of batch, in order, onto branch of target as a merge commit carrying the Cinder-Change,
// Cinder-Agent and owners.Trailer trailers, and pushes them at once. A merge commit keeps the fork's commits (and the
// head SHA approvals are bound to) unchanged. A target that moved past a change's verified base, or a change whose merged tree isn't the tree its verify checked refuses
// the whole batch: nothing is pushed. token writes the target. A non-nil sign returns the
// SSH signature of a commit object (the Worker signs it; the key never reaches the runner), so `cinder verify-commit`
// can check the merge offline. An empty signature (the Worker has no signing key yet) leaves the merge unsigned.
func merge(ctx context.Context, token, target, branch string, batch []landing, agent string, version int, sign func(commit string) (string, error)) (string, error) {
	if len(batch) == 0 {
		return "", fmt.Errorf("merge: the job names no changes to land")
	}
	dir, err := os.MkdirTemp("", "cinder-merge-")
	if err != nil {
		return "", err
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
	if _, err := git(token, "clone", "--quiet", "--branch", branch, target, "."); err != nil {
		return "", err
	}
	tip, err := git("", "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	ref := fmt.Sprintf("%s@v%d", agent, version)
	for _, l := range batch {
		if l.Base != "" && l.Base != tip {
			return "", fmt.Errorf("merge refused: target %s moved to %s after change %s verified on %s", branch, tip, l.Change, l.Base)
		}
		// The head, not the fork's branch: a person's push sits under refs/for/<branch> or its own head branch.
		if _, err := git(string(l.Token), "fetch", "--quiet", l.Remote, cmp.Or(l.Head, branch)); err != nil {
			return "", err
		}
		// The subject names the change by its key (PULSE-6: <title>); a change without one keeps its id.
		subject := "cinder: merge change " + l.Change
		if l.Key != "" {
			subject = l.Key + ": " + l.Title
		}
		msg := fmt.Sprintf("%s\n\nCinder-Change: %s\nCinder-Agent: %s\n%s: %s", subject, l.Change, ref, owners.Trailer, ref)
		if _, err := git("", "merge", "--quiet", "--no-ff", "-m", msg, "FETCH_HEAD"); err != nil {
			return "", err
		}
		if tree, err := git("", "rev-parse", "HEAD^{tree}"); err != nil || tree != l.Tree {
			return "", fmt.Errorf("merge refused: change %s merges to tree %s, its verify checked %q (%v)", l.Change, tree, l.Tree, err)
		}
		if sign == nil {
			continue
		}
		// git's own signing runs a local key; here the commit is re-written with a gpgsig header from sign instead.
		body, err := exec.CommandContext(ctx, "git", "-C", dir, "cat-file", "commit", "HEAD").Output()
		if err != nil {
			return "", fmt.Errorf("git cat-file: %w", err)
		}
		sig, err := sign(string(body))
		if err != nil {
			return "", err
		}
		if sig != "" {
			head, rest, _ := strings.Cut(string(body), "\n\n")
			signed := filepath.Join(dir, ".git", "cinder-signed-commit")
			header := "gpgsig " + strings.ReplaceAll(strings.TrimSuffix(sig, "\n"), "\n", "\n ")
			if err := os.WriteFile(signed, []byte(head+"\n"+header+"\n\n"+rest), 0o600); err != nil {
				return "", err
			}
			sha, err := git("", "hash-object", "-t", "commit", "-w", signed)
			if err != nil {
				return "", err
			}
			if _, err := git("", "update-ref", "HEAD", sha); err != nil {
				return "", err
			}
		}
	}
	if _, err := git(token, "push", "--quiet", "origin", "HEAD:"+branch); err != nil {
		return "", err
	}
	return git("", "rev-parse", "HEAD")
}
