package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/decl"
	"github.com/brinkercode/cinder/runner/internal/egress"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/harness"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

// resolvePayload is a resolve job's payload, as worker/src/work.js queues it.
type resolvePayload struct {
	Intent  string             `json:"intent"`
	Theirs  []api.ChangeIntent `json:"theirs"`
	Hunks   []json.RawMessage  `json:"hunks"`
	Symbols []string           `json:"symbols"`
}

// resolveConflict merges branch of target into fork, runs the harness on the conflicted clone with both
// intents, the target's diff since the fork's base (the other change) and the hunks, commits as
// cinder-agent and pushes the fork. token writes the fork, readToken reads the target. The harness
// reaches the network only through a proxy allowing allow, the model provider and the fork's host. used gets the harness's result,
// pushed the symbols the change's diff against the target writes and reads.
// lazy: theirs' diff is read from the target, so a change that only holds a lease (not yet merged) contributes none.
func resolveConflict(ctx context.Context, token, readToken, fork, target, branch string, p resolvePayload, allow []string, spec harness.Spec, used *harness.Result, pushed *api.Report) (string, error) {
	dir, err := os.MkdirTemp("", "cinder-resolve-")
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
	if _, err := git(token, "clone", "--quiet", "--branch", branch, fork, "."); err != nil {
		return "", err
	}
	defer watchActivity(ctx, dir, spec.Metadata["job"], time.Second)()
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if err := decl.InstallDriver(dir, filepath.Join(filepath.Dir(exe), "cinder-verify")); err != nil {
		return "", err
	}
	if _, err := git(readToken, "fetch", "--quiet", target, branch); err != nil {
		return "", err
	}
	theirDiff, err := git("", "diff", "HEAD...FETCH_HEAD")
	if err != nil {
		return "", err
	}
	// A conflicted merge exits non-zero but leaves MERGE_HEAD; anything else is a real failure.
	if _, mergeErr := git("", "merge", "--quiet", "--no-ff", "--no-commit", "FETCH_HEAD"); mergeErr != nil {
		if _, err := git("", "rev-parse", "-q", "--verify", "MERGE_HEAD"); err != nil {
			return "", mergeErr
		}
	}
	hunks, err := json.Marshal(p.Hunks)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Resolve the merge conflict in this working tree.\n\n## Our intent\n%s\n", p.Intent)
	for _, t := range p.Theirs {
		fmt.Fprintf(&b, "\n## Their intent (change %s)\n%s\n", t.ID, t.Intent)
	}
	fmt.Fprintf(&b, "\n## Their diff\n%s\n\n## Conflict hunks\n%s\n", theirDiff, hunks)
	if len(p.Symbols) > 0 {
		fmt.Fprintf(&b, "\n## Conflicting symbols\n%s\n", strings.Join(p.Symbols, "\n"))
	}
	spec.Prompt = b.String() + "\n---\n\n" + spec.Prompt
	spec.Workdir = dir
	for _, s := range []string{token, readToken} {
		if s != "" {
			spec.Secrets = append(spec.Secrets, s)
		}
	}
	forkURL, err := url.Parse(fork)
	if err != nil {
		return "", err
	}
	proxy, err := egress.Start(allow, false, harness.ProviderHost(spec), forkURL.Hostname())
	if err != nil {
		return "", err
	}
	defer proxy.Close()
	spec.Env = append(spec.Env, proxy.AgentEnv()...)
	res, err := harness.Run(ctx, spec)
	*used = res
	if err != nil {
		return "", err
	}
	// post-merge doesn't run on a merge that stopped on conflicts, so regenerate lockfiles here.
	if err := decl.Relock(dir); err != nil {
		return "", err
	}
	if _, err := git("", "add", "-A"); err != nil {
		return "", err
	}
	// Commit the merge; when the target was already merged there is nothing to commit.
	_, noMerge := git("", "rev-parse", "-q", "--verify", "MERGE_HEAD")
	staged, err := git("", "diff", "--cached", "--name-only")
	if err != nil {
		return "", err
	}
	if noMerge == nil || staged != "" {
		if _, err := git("", "commit", "--quiet", "-m", "cinder-agent: resolve"); err != nil {
			return "", err
		}
	}
	diff, err := git("", "diff", "-U0", "--no-renames", "FETCH_HEAD", "HEAD")
	if err != nil {
		return "", err
	}
	all, err := symbols.Index(dir)
	if err != nil {
		return "", err
	}
	ch, err := symbols.Diff(diff, func(p string) []decl.Symbol {
		src, err := git("", "show", "FETCH_HEAD:"+p)
		if err != nil { // not in the target: an added file
			return nil
		}
		return symbols.File(p, []byte(src))
	}, symbols.ByPath(all))
	if err != nil {
		return "", err
	}
	pushed.Writes, pushed.Reads = ch.Writes, ch.Reads
	if _, err := git(token, "push", "--quiet", "origin", "HEAD:"+branch); err != nil {
		return "", err
	}
	return git("", "rev-parse", "HEAD")
}
