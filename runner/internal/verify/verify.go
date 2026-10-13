// Package verify runs a verify job: the target branch, the fork's head on top,
// acceptance files from the job overlaid, then the repo's check.
package verify

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

// BaseEnv is all a repo's code gets of the runner's environment: PATH, HOME and the CA files that make intercepted HTTPS
// verify (a pool container's Containers CA), never a token.
func BaseEnv() []string {
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	for _, k := range []string{"SSL_CERT_FILE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// Job is a verify job's payload. Acceptance comes from here, never from the fork.
type Job struct {
	Target, Branch string            // target repo URL and branch
	Fork, Head     string            // fork repo URL and the ref or commit to verify
	Acceptance     map[string]string // repo-relative path -> content
	Check          string            // the policy's check command
	Results        string            // repo-relative test result file, returned if found
	Timeout        time.Duration     // for Check; default 15 min
	ReadToken      api.Secret        // reads Target when set; the job's token reads Fork (and Target when this is empty)
	Ahead          []Ahead           // the queued changes ahead, merged in order onto Branch before Head
	Only           []string          // a retry's failed tests; Check reads them from CINDER_ONLY_TESTS, one per line
	Leases         []Lease           // every lease granted on Branch, for the Check leases step
}

// Lease is a symbol ("path" or "path#name") a change holds on the target branch.
type Lease struct {
	Symbol string `json:"symbol"`
	Holder string `json:"holder"`
}

// Ahead is one queued change ahead of a speculative verify: its fork, its head and a token that reads the fork.
type Ahead struct {
	Remote string     `json:"remote"`
	Head   string     `json:"head_sha"`
	Token  api.Secret `json:"token"`
}

// Run checks out j into dir (which must not exist yet) and reports the check's result.
func Run(ctx context.Context, dir string, token api.Secret, j Job) api.Report {
	rep, _ := run(ctx, dir, token, j)
	return rep
}

// run is Run; checkFailed is true only when the check itself ran and exited non-zero.
func run(ctx context.Context, dir string, token api.Secret, j Job) (rep api.Report, checkFailed bool) {
	if j.Check == "" {
		return api.Report{Status: "failed", Detail: "no check in policy"}, false
	}
	if err := gitauth.HasBranch(ctx, string(cmp.Or(j.ReadToken, token)), j.Target, j.Branch); err != nil {
		return api.Report{Status: "failed", Detail: err.Error()}, false
	}
	type step struct {
		tok  api.Secret
		args []string
	}
	steps := []step{{cmp.Or(j.ReadToken, token), []string{"clone", "--branch", j.Branch, "--", j.Target, dir}}}
	if j.Fork != "" {
		// The tree the merge will land: the target, each change ahead merged in order, then this change merged on top. The
		// branch ref moves to the changes ahead, so findings stay on this change's own lines.
		merge := []string{"-C", dir, "-c", "user.name=cinder-verify", "-c", "user.email=cinder-verify@cinder.invalid", "merge", "--quiet", "--no-ff", "--no-edit", "FETCH_HEAD"}
		steps = append(steps, step{"", []string{"-C", dir, "checkout", "--quiet", "--detach"}})
		for _, a := range j.Ahead {
			steps = append(steps, step{a.Token, []string{"-C", dir, "fetch", "--", a.Remote, cmp.Or(a.Head, j.Branch)}}, step{"", merge})
		}
		steps = append(steps, step{"", []string{"-C", dir, "update-ref", "refs/heads/" + j.Branch, "HEAD"}},
			step{token, []string{"-C", dir, "fetch", "--", j.Fork, j.Head}}, step{"", merge})
	}
	for _, s := range steps {
		if out, err := gitauth.Command(ctx, string(s.tok), s.args...).CombinedOutput(); err != nil {
			return api.Report{Status: "failed", Detail: fmt.Sprintf("git: %v\n%s", err, tail(out))}, false
		}
	}
	// The tree this verify checked and the target sha it merged onto; the merge lands a change only onto this exact tree.
	var tree, base, logged string
	if j.Fork != "" {
		out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "HEAD^{tree}", "refs/remotes/origin/"+j.Branch).Output()
		if err != nil {
			return api.Report{Status: "failed", Detail: fmt.Sprintf("git rev-parse: %v", err)}, false
		}
		tree, base, _ = strings.Cut(strings.TrimSpace(string(out)), "\n")
		if logged, err = changeSteps(ctx, dir, j, base); err != nil {
			return api.Report{Status: "failed", Detail: fmt.Sprintf("git diff: %v", err)}, false
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return api.Report{Status: "failed", Detail: err.Error()}, false
	}
	defer root.Close()
	// os.Root refuses paths and symlinks that leave dir; RemoveAll first stops a fork's
	// symlink redirecting the write. cmp.Or runs all three in order, returns the first error.
	for p, body := range j.Acceptance {
		err := cmp.Or(root.RemoveAll(p), root.MkdirAll(filepath.Dir(p), 0o755), root.WriteFile(p, []byte(body), 0o644))
		if err != nil {
			return api.Report{Status: "failed", Detail: fmt.Sprintf("overlay %s: %v", p, err)}, false
		}
	}

	timeout := cmp.Or(j.Timeout, 15*time.Minute)
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "sh", "-c", j.Check)
	cmd.Dir = dir
	// The check is the repo's code: it never sees the runner's tokens, as flow steps don't.
	cmd.Env = BaseEnv()
	if len(j.Only) > 0 {
		cmd.Env = append(cmd.Env, "CINDER_ONLY_TESTS="+strings.Join(j.Only, "\n"))
	}
	// Kill the whole process group on timeout; WaitDelay stops a stray child holding the output pipe from hanging us.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
	rep = api.Report{Status: "done", Detail: tail(out), Tree: tree, Base: base}
	switch {
	case cctx.Err() != nil:
		rep.Status, rep.Detail = "failed", fmt.Sprintf("check timed out after %s\n%s", timeout, rep.Detail)
	case err != nil:
		rep.Status, checkFailed = "failed", true
	}
	if j.Fork != "" {
		// Fail closed: a SARIF or diff we can't read would hide blockers.
		if rep.Findings, err = findings(ctx, dir, j.Branch); err != nil {
			rep.Status, rep.Detail = "failed", fmt.Sprintf("sarif: %v\n%s", err, rep.Detail)
		}
		// The final diff's writes, which the Worker checks against the change's lease before it queues.
		if j.Branch != "" {
			diff, err := exec.CommandContext(ctx, "git", "-C", dir, "diff", "-U0", "--no-ext-diff", "--no-textconv", "--no-renames", "refs/heads/"+j.Branch+"...HEAD", "--").Output()
			if err == nil {
				_, rep.Writes, rep.Reads, err = symbols.Push(dir, string(diff))
			}
			if err != nil {
				rep.Status, rep.Detail = "failed", fmt.Sprintf("writes: %v\n%s", err, rep.Detail)
			}
		}
	}
	if j.Results != "" {
		if b, err := root.ReadFile(j.Results); err == nil {
			rep.Results = string(b)
			if rep.Tests, err = parseResults(b); err != nil {
				rep.Detail = fmt.Sprintf("parse %s: %v\n%s", j.Results, err, rep.Detail)
			}
		}
	}
	rep.Detail = logged + rep.Detail
	return rep, checkFailed
}

// changeSteps logs the Fetch change step (the head merged onto the target's sha, with its diffstat) and the Check
// leases step (each file the change touches with its leases, or none) as ##[group] sections.
func changeSteps(ctx context.Context, dir string, j Job, base string) (string, error) {
	diff := []string{"-C", dir, "diff", "--no-ext-diff", "--no-renames", "refs/heads/" + j.Branch + "...HEAD", "--"}
	stat, err := exec.CommandContext(ctx, "git", slices.Insert(diff, 3, "--stat")...).Output()
	if err != nil {
		return "", err
	}
	names, err := exec.CommandContext(ctx, "git", slices.Insert(diff, 3, "--name-only", "-z")...).Output()
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "##[group]Fetch change\nFetching %s against %s @ %.7s\n%s##[endgroup]\n##[group]Check leases\n", j.Head, j.Branch, base, stat)
	for _, f := range strings.Split(strings.TrimSuffix(string(names), "\x00"), "\x00") {
		if f == "" {
			continue
		}
		held := false
		for _, l := range j.Leases {
			if l.Symbol == f || strings.HasPrefix(l.Symbol, f+"#") {
				fmt.Fprintf(&b, "Lease %s · %s\n", l.Symbol, l.Holder)
				held = true
			}
		}
		if !held {
			fmt.Fprintf(&b, "Lease %s · none\n", f)
		}
	}
	return b.String() + "##[endgroup]\n", nil
}

func tail(b []byte) string { return string(b[max(0, len(b)-6<<10):]) } // last 6 KB
