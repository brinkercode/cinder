// Command cinder-verify claims and runs jobs of every kind: verify, flow, scan, refs, guard, index, blame, compare and
// ingest-sarif itself, the rest through cinder-agent. It is the pool image's entrypoint. Config: CINDER_URL, CINDER_RUNNER_TOKEN.
//
//	cinder-verify merge-driver %O %A %B %P  git merge driver: declaration merge into %A
//	cinder-verify symbols <dir>             JSON lines: symbols with hashes and reads (Go, JS/TS), a file-level entry otherwise
//	cinder-verify blame <dir> <ref> <path>  JSON list of who wrote each line (owners.Line)
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/decl"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/loop"
	"github.com/brinkercode/cinder/runner/internal/owners"
	"github.com/brinkercode/cinder/runner/internal/symbols"
	"github.com/brinkercode/cinder/runner/internal/verify"
)

func main() {
	if len(os.Args) == 6 && os.Args[1] == "merge-driver" {
		os.Exit(mergeDriver(os.Args[2], os.Args[3], os.Args[4], os.Args[5]))
	}
	if len(os.Args) == 3 && os.Args[1] == "symbols" {
		if err := listSymbols(os.Stdout, os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, "cinder-verify:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 5 && os.Args[1] == "blame" {
		lines, err := owners.Blame(context.Background(), os.Args[2], os.Args[3], os.Args[4])
		if err == nil {
			err = json.NewEncoder(os.Stdout).Encode(lines)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "cinder-verify:", err)
			os.Exit(1)
		}
		return
	}
	url, token := os.Getenv("CINDER_URL"), os.Getenv("CINDER_RUNNER_TOKEN")
	if url == "" || token == "" {
		fmt.Fprintln(os.Stderr, "cinder-verify: CINDER_URL and CINDER_RUNNER_TOKEN must be set")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client := &api.Client{BaseURL: url, Token: token}
	// A job still running after maxJob fails; the Worker's backstop (flows.js timeOutFlowJobs) fails any it outlives.
	r := &loop.Runner{Client: client, Slots: 1, Exec: dispatch(client), MaxJob: maxJob}
	if err := r.Run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "cinder-verify:", err)
		os.Exit(1)
	}
}

// maxJob bounds one claimed job, set up to report: a flow's steps each stop at stepTimeout, so 90 minutes fits the longest seeded flow job.
const maxJob = 90 * time.Minute

// dispatch runs a flow job with runFlow, which reports its steps through client, and every other kind with run.
func dispatch(client *api.Client) func(context.Context, *api.Claim) api.Report {
	return func(ctx context.Context, c *api.Claim) api.Report {
		switch c.Job.Kind {
		case "flow":
			return runFlow(ctx, client, c)
		case "index", "blame", "compare":
			return runResult(ctx, client, c)
		}
		return run(ctx, c)
	}
}

// run executes one claimed job: verify, scan, refs, guard or ingest-sarif; every other kind goes to cinder-agent.
func run(ctx context.Context, c *api.Claim) api.Report {
	switch c.Job.Kind {
	case "scan":
		// A full scan of the target branch at sha with the repo's check; the claim's read token is the only token.
		var p struct{ Target, Sha, Check string }
		if err := json.Unmarshal(c.Payload, &p); err != nil || p.Target == "" || p.Sha == "" {
			return api.Report{Status: "failed", Detail: "cinder-verify: scan payload needs target and sha"}
		}
		dir, err := os.MkdirTemp("", "cinder-scan-")
		if err != nil {
			return api.Report{Status: "failed", Detail: err.Error()}
		}
		defer os.RemoveAll(dir)
		return verify.Scan(ctx, filepath.Join(dir, "repo"), c.ReadToken, verify.Job{Target: c.TargetRemote, Branch: p.Target, Head: p.Sha, Check: p.Check})
	case "ingest-sarif":
		return verify.Ingest(c.Payload)
	case "guard":
		// The push a fork received, read with the claim's fork read token.
		var p struct{ Before, After, Target string }
		if err := json.Unmarshal(c.Payload, &p); err != nil || p.After == "" || c.ForkRemote == "" {
			return api.Report{Status: "failed", Detail: "cinder-verify: guard claim needs a fork and a payload with after"}
		}
		dir, err := os.MkdirTemp("", "cinder-guard-")
		if err != nil {
			return api.Report{Status: "failed", Detail: err.Error()}
		}
		defer os.RemoveAll(dir)
		return verify.Guard(ctx, filepath.Join(dir, "repo"), c.ReadToken, c.ForkRemote, p.Before, p.After, p.Target)
	case "refs":
		// The Artifacts binding lists no refs, so the branches page gets them from git.
		out, err := gitauth.Command(ctx, string(c.ReadToken), "ls-remote", "--heads", "--", c.TargetRemote).CombinedOutput()
		if err != nil {
			return api.Report{Status: "failed", Detail: fmt.Sprintf("git ls-remote: %v\n%s", err, out)}
		}
		var refs []string
		for _, line := range strings.Split(string(out), "\n") {
			if _, ref, ok := strings.Cut(line, "\trefs/heads/"); ok {
				refs = append(refs, ref)
			}
		}
		return api.Report{Status: "done", Refs: refs}
	case "verify":
		// The repo's policy check on the fork's head (head_sha when the job names it) merged onto the changes ahead of it;
		// the report's detail is the check's log.
		var p struct {
			Check   string
			HeadSHA string `json:"head_sha"`
			Ahead   []verify.Ahead
			Only    []string
			Leases  []verify.Lease
		}
		if err := json.Unmarshal(c.Payload, &p); err != nil || c.Change == nil {
			return api.Report{Status: "failed", Detail: "cinder-verify: verify claim needs a change and a payload"}
		}
		dir, err := os.MkdirTemp("", "cinder-verify-")
		if err != nil {
			return api.Report{Status: "failed", Detail: err.Error()}
		}
		defer os.RemoveAll(dir)
		head := c.Change.TargetBranch
		if p.HeadSHA != "" {
			head = p.HeadSHA
		}
		return verify.Run(ctx, filepath.Join(dir, "repo"), c.GitToken, verify.Job{Target: c.TargetRemote, Branch: c.Change.TargetBranch,
			Fork: c.ForkRemote, Head: head, Check: p.Check, ReadToken: c.ReadToken, Ahead: p.Ahead, Only: p.Only, Leases: p.Leases})
	default:
		return runAgent(ctx, c)
	}
}

// runAgent runs a claim on cinder-agent, so one entrypoint runs every kind. The claim and its tokens go over stdin,
// never argv or env.
func runAgent(ctx context.Context, c *api.Claim) api.Report {
	in, err := json.Marshal(c)
	if err != nil {
		return api.Report{Status: "failed", Detail: "cinder-verify: " + err.Error()}
	}
	cmd := exec.CommandContext(ctx, "cinder-agent", "run-claim")
	cmd.Stdin, cmd.Stderr = bytes.NewReader(in), os.Stderr
	// At the job's deadline or a cancel, SIGTERM lets cinder-agent kill its harness's process group; a minute later it's killed.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = time.Minute
	out, err := cmd.Output()
	var rep api.Report
	if err == nil {
		err = json.Unmarshal(out, &rep)
	}
	if err != nil {
		return api.Report{Status: "failed", Detail: "cinder-verify: cinder-agent run-claim: " + err.Error()}
	}
	return rep
}

// mergeDriver writes the merge into ours and returns git's driver exit code: 0 clean, 1 conflicts left.
func mergeDriver(base, ours, theirs, path string) int {
	var src [3][]byte
	for i, p := range []string{base, ours, theirs} {
		b, err := os.ReadFile(p)
		if err != nil {
			fmt.Fprintln(os.Stderr, "cinder-verify merge-driver:", err)
			return 1
		}
		src[i] = b
	}
	lang := map[string]string{".go": "go", ".js": "js", ".jsx": "js"}[filepath.Ext(path)]
	out, ok, err := decl.Merge(src[0], src[1], src[2], lang)
	if err == nil {
		err = os.WriteFile(ours, out, 0o644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "cinder-verify merge-driver:", err)
		return 1
	}
	if !ok {
		return 1
	}
	return 0
}

// listSymbols writes one JSON symbol per line for every file under dir, as an index job reports them.
func listSymbols(w io.Writer, dir string) error {
	list, err := symbols.Index(dir)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	for _, s := range list {
		if err := enc.Encode(s); err != nil {
			return err
		}
	}
	return nil
}
