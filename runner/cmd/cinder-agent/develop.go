package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/decl"
	"github.com/brinkercode/cinder/runner/internal/edits"
	"github.com/brinkercode/cinder/runner/internal/egress"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/harness"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

// developed is what a develop job reports.
type developed struct {
	Head      string   `json:"head"`
	CostUSD   float64  `json:"cost_usd"`
	CostKnown bool     `json:"cost_known"`
	Tokens    int64    `json:"-"` // reported to model usage, not in the detail
	SessionID string   `json:"session_id"`
	Files     []string `json:"files"`
	// Symbols is every symbol the diff from the fork's head touched.
	Symbols []symbols.Touch `json:"symbols"`
	// Changes is every symbol the diff writes (signature or body) and reads.
	Changes symbols.Changes `json:"changes"`
	// EgressBlocked is every host the harness tried to reach outside the agent's egress list.
	EgressBlocked []string `json:"egress_blocked"`
	// Egress, Writes and Reads go in the job report itself, not its detail.
	Egress *api.Egress     `json:"-"`
	Writes []symbols.Write `json:"-"`
	Reads  []string        `json:"-"`
}

// develop clones fork, runs the harness in the clone, commits whatever changed as
// cinder-agent, pushes the fork and returns head sha, cost, session and touched files.
// spec.Workdir is replaced by the clone. Cost and session are returned even on failure.
// prior is the change's earlier attempts: runner resumes the last session when it made it,
// otherwise it starts a new session whose prompt is seeded with that history.
// The harness reaches the network only through a proxy allowing allow (the agent version's
// egress), the model provider and the fork's Artifacts host.
// check, when set, checks edits: claude-code's hooks around each edit and on stop; then the finish gate fails the run while
// an error is open, after resuming a harness without edit hooks once with the gate's errors and warnings as context.
func develop(ctx context.Context, token, fork, branch, runner string, prior []api.Attempt, allow []string, audit bool, spec harness.Spec, check edits.Checker) (developed, error) {
	dir, err := os.MkdirTemp("", "cinder-develop-")
	if err != nil {
		return developed{}, err
	}
	defer os.RemoveAll(dir)
	git := func(args ...string) (string, error) {
		cmd := gitauth.Command(ctx, token, append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %w: %s", args[0], err, out)
		}
		return strings.TrimSpace(string(out)), nil
	}
	if _, err := git("clone", "--quiet", "--branch", branch, fork, "."); err != nil {
		return developed{}, err
	}
	defer watchActivity(ctx, dir, spec.Metadata["job"], time.Second)()
	// cinder-verify is installed next to cinder-agent (deploy/*.service).
	exe, err := os.Executable()
	if err != nil {
		return developed{}, err
	}
	if err := decl.InstallDriver(dir, filepath.Join(filepath.Dir(exe), "cinder-verify")); err != nil {
		return developed{}, err
	}
	base, err := git("rev-parse", "HEAD")
	if err != nil {
		return developed{}, err
	}
	spec.Workdir = dir
	// Claude sessions are stored on the machine that ran them, so only that runner can resume one.
	if n := len(prior); n > 0 && prior[n-1].Runner == runner && prior[n-1].SessionID != "" {
		spec.Resume = prior[n-1].SessionID
	} else if n > 0 {
		var b strings.Builder
		b.WriteString("Earlier attempts at this change, oldest first:\n")
		for i, a := range prior {
			fmt.Fprintf(&b, "\n## Attempt %d (runner %s, session %s)\n%s\n\nVerdict log tail:\n%s\n",
				i+1, a.Runner, a.SessionID, a.Summary, a.LogTail)
		}
		spec.Prompt = b.String() + "\n---\n\n" + spec.Prompt
	}
	if token != "" {
		spec.Secrets = append(spec.Secrets, token)
	}
	forkURL, err := url.Parse(fork)
	if err != nil {
		return developed{}, err
	}
	proxy, err := egress.Start(allow, audit, harness.ProviderHost(spec), forkURL.Hostname())
	if err != nil {
		return developed{}, err
	}
	defer proxy.Close()
	spec.Env = append(spec.Env, proxy.AgentEnv()...)
	var gate *edits.Gate
	if check != nil {
		gate = &edits.Gate{Dir: dir, Base: base, Check: check}
		hookURL, stop, err := gate.Serve(ctx)
		if err != nil {
			return developed{}, err
		}
		defer stop()
		spec.Env = append(spec.Env, "CINDER_EDIT_HOOK="+hookURL)
		spec.Hook = strconv.Quote(exe) + " edit-hook"
	}
	res, runErr := harness.Run(ctx, spec)
	if gate != nil && runErr == nil && (spec.Harness == "opencode" || spec.Harness == "codex") && res.SessionID != "" {
		var diags []edits.Diagnostic
		diags, _, runErr = gate.Finish(ctx)
		if found := edits.Text(diags, "error", "warning"); runErr == nil && found != "" {
			again := spec
			again.Resume, again.System, again.Prompt = res.SessionID, "", "The edit check found collisions with other changes. Fix the errors, or report a blocker:\n"+found
			var more harness.Result
			more, runErr = harness.Run(ctx, again)
			res.CostUSD, res.Tokens = res.CostUSD+more.CostUSD, res.Tokens+more.Tokens
		}
	}
	allowed, denied := proxy.Counts()
	d := developed{CostUSD: res.CostUSD, CostKnown: res.CostKnown, Tokens: res.Tokens, SessionID: res.SessionID, EgressBlocked: proxy.Blocked(),
		Egress: &api.Egress{Allowed: allowed, Denied: denied, WouldDeny: proxy.WouldDeny()}}
	if runErr != nil {
		return d, runErr
	}
	// Collisions the agent couldn't fix are pushed and reported: cinder settles them (stack or seam) from the report's writes.
	if _, err := git("add", "-A"); err != nil {
		return d, err
	}
	// commit fails on an empty index, so only commit when something is staged.
	if staged, err := git("diff", "--cached", "--name-only"); err != nil {
		return d, err
	} else if staged != "" {
		if _, err := git("-c", "user.name=cinder-agent", "-c", "user.email=cinder-agent@cinder.invalid",
			"commit", "--quiet", "-m", "cinder-agent: develop"); err != nil {
			return d, err
		}
	}
	if d.Head, err = git("rev-parse", "HEAD"); err != nil {
		return d, err
	}
	files, err := git("diff", "--name-only", base, d.Head)
	if err != nil {
		return d, err
	}
	d.Files = strings.FieldsFunc(files, func(r rune) bool { return r == '\n' })
	diff, err := git("diff", "-U0", "--no-renames", base, d.Head)
	if err != nil {
		return d, err
	}
	all, err := symbols.Index(dir)
	if err != nil {
		return d, err
	}
	after := symbols.ByPath(all)
	if d.Symbols, err = symbols.Touched(diff, after); err != nil {
		return d, err
	}
	if d.Changes, err = symbols.Diff(diff, func(path string) []decl.Symbol {
		src, err := git("show", base+":"+path)
		if err != nil { // not in base: an added file
			return nil
		}
		return symbols.File(path, []byte(src))
	}, after); err != nil {
		return d, err
	}
	d.Writes, d.Reads = d.Changes.Writes, d.Changes.Reads
	if _, err := git("push", "--quiet", "origin", "HEAD:"+branch); err != nil {
		return d, err
	}
	return d, nil
}
