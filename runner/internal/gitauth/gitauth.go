// Package gitauth runs git with an Artifacts token passed only through the
// environment (GIT_CONFIG_COUNT/KEY/VALUE), never argv, so it can't show in ps or logs.
package gitauth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
)

// fresh maps a claim's token to the newest one a heartbeat returned for it.
var fresh sync.Map

// Refresh makes Command send latest wherever it is given claimed; an empty latest forgets claimed.
func Refresh(claimed, latest string) {
	if claimed == "" {
		return
	}
	if latest == "" {
		fresh.Delete(claimed)
		return
	}
	fresh.Store(claimed, latest)
}

// Command builds a git command that sends token as an http.extraHeader. Prompts
// are off: a runner has no terminal, and a prompt would hang the slot. Our
// GIT_CONFIG_* entries come last, and exec keeps the last value of a duplicate key.
// CINDER_* (the runner token) is dropped: git runs hooks and merge drivers in the repo.
// In a pool container a clone is blobless: later commands fetch the blobs they need from its remote, and cinder's egress
// gives those tokenless git reads a short-lived token (worker workers.js gitRead). A BYO runner has no such egress, so
// it clones in full. A --mirror clone stays full, as the secret scan reads every blob.
func Command(ctx context.Context, token string, args ...string) *exec.Cmd {
	i := 0
	for i+1 < len(args) && (args[i] == "-C" || args[i] == "-c") {
		i += 2
	}
	if pooled() && i < len(args) && args[i] == "clone" && !slices.Contains(args, "--mirror") {
		args = slices.Concat(args[:i+1], []string{"--filter=blob:none"}, args[i+1:])
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "CINDER_") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	// A job's code can write a global or system config (core.hooksPath, core.fsmonitor) that would run with this token.
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
	if t, ok := fresh.Load(token); ok {
		token = t.(string)
	}
	if token != "" {
		cmd.Env = append(cmd.Env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.extraHeader",
			"GIT_CONFIG_VALUE_0=Authorization: Bearer "+token)
	}
	return cmd
}

// HasBranch reports "target <branch> has no commits" when remote has no such branch, so a job on an
// empty repo fails with that instead of a git error from deep inside it.
// pooled reports whether this runner is a pool container, which reaches cinder through its egress at cinder.internal.
func pooled() bool { return strings.HasPrefix(os.Getenv("CINDER_URL"), "http://cinder.internal") }

func HasBranch(ctx context.Context, token, remote, branch string) error {
	out, err := Command(ctx, token, "ls-remote", "--exit-code", "--", remote, "refs/heads/"+branch).CombinedOutput()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 2 {
		return fmt.Errorf("target %s has no commits", branch)
	}
	if err != nil {
		return fmt.Errorf("git ls-remote: %w: %s", err, out)
	}
	return nil
}
