// Command cinder-agent claims jobs and runs each with its kind's handler. Config: CINDER_URL, CINDER_RUNNER_TOKEN.
package main

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/edits"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/harness"
	"github.com/brinkercode/cinder/runner/internal/loop"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

func main() {
	// cinder-verify, the image's entrypoint, hands the kinds it doesn't run here: a Claim on stdin, its Report on stdout.
	if len(os.Args) == 2 && os.Args[1] == "run-claim" {
		if err := runClaim(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "cinder-agent run-claim:", err)
			os.Exit(1)
		}
		return
	}
	// The harness's edit hook (edits.Gate.Hook): the hook event on stdin goes to the develop run's gate, its answer to stdout.
	if len(os.Args) == 2 && os.Args[1] == "edit-hook" {
		if err := editHook(os.Getenv("CINDER_EDIT_HOOK")); err != nil {
			fmt.Fprintln(os.Stderr, "cinder-agent edit-hook:", err)
			os.Exit(1)
		}
		return
	}
	url, token := os.Getenv("CINDER_URL"), os.Getenv("CINDER_RUNNER_TOKEN")
	if url == "" || token == "" {
		fmt.Fprintln(os.Stderr, "cinder-agent: CINDER_URL and CINDER_RUNNER_TOKEN must be set")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client = &api.Client{BaseURL: url, Token: token}
	r := &loop.Runner{Client: client, Slots: 1, Exec: run}
	if err := r.Run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "cinder-agent:", err)
		os.Exit(1)
	}
}

// runClaim runs the Claim on in and writes its Report to out. cinder-verify's CINDER_URL and CINDER_RUNNER_TOKEN, inherited
// from the pool container, give it the Worker that model usage, merge signing and edit checks go to; without them it runs
// with none.
func runClaim(in io.Reader, out io.Writer) error {
	var c api.Claim
	if err := json.NewDecoder(in).Decode(&c); err != nil {
		return err
	}
	if url, token := os.Getenv("CINDER_URL"), os.Getenv("CINDER_RUNNER_TOKEN"); url != "" && token != "" {
		client = &api.Client{BaseURL: url, Token: token}
	}
	// cinder-verify sends SIGTERM at the job's deadline: the harness's process group is killed and the run reports failed.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	return json.NewEncoder(out).Encode(run(ctx, &c))
}

// client is the Worker main runs with; a merge signs through it. nil (in tests) merges unsigned.
var client *api.Client

// run dispatches a claimed job to its kind's handler and reports that handler's result; an unknown kind fails.
// Every kind here belongs to a change; the forks and target are the claim's remotes, on the change's target branch.
func run(ctx context.Context, c *api.Claim) (rep api.Report) {
	start := time.Now()
	var used harness.Result
	defer func() {
		rep.DurationMS, rep.CostUSD = time.Since(start).Milliseconds(), used.CostUSD
		if used.Tokens > 0 {
			// lazy: harnesses report one total, sent as input; split in/out/cache once harness.Result carries them.
			rep.Tokens = &[3]int64{used.Tokens, 0, 0}
		}
	}()
	var p struct {
		resolvePayload
		Path    string            `json:"path"`
		Content string            `json:"content"`
		Thread  string            `json:"thread"`
		Ref     string            `json:"ref"`
		Files   map[string]string `json:"files"`
		Name    string            `json:"name"`
		Remote  string            `json:"remote"`
		Draft   *draft            `json:"draft"`
		Batch   []landing         `json:"batch"`
	}
	if len(c.Payload) > 0 {
		if err := json.Unmarshal(c.Payload, &p); err != nil {
			return api.Report{Status: "failed", Detail: "cinder-agent: bad " + c.Job.Kind + " payload: " + err.Error()}
		}
	}
	ch := cmp.Or(c.Change, &api.Change{})
	tok, read, fork, target, branch := string(c.GitToken), string(c.ReadToken), c.ForkRemote, c.TargetRemote, ch.TargetBranch
	// The kind's own handler works on this remote's branch, so check it has commits before any git step.
	if remote := map[string]string{"develop": fork, "resolve": fork, "converge": fork, "commit": fork, "merge": target}[c.Job.Kind]; remote != "" {
		if err := gitauth.HasBranch(ctx, tok, remote, branch); err != nil {
			return api.Report{Status: "failed", Detail: err.Error()}
		}
	}
	// No agent version leaves the harness defaults, and the merge trailer names cinder-agent@v0.
	agent := cmp.Or(c.Agent, &api.Agent{Agent: "cinder-agent"})
	spec := harness.Spec{Harness: agent.Harness, Model: agent.Model, System: agent.Prompt, MaxUSD: agent.Limits.MaxSpend}
	// The gateway logs attribute each model call to this run (worker/src/usage.js); a cinder run's person is its runner.
	person := "runner"
	if c.Job.RunnerID != nil {
		person += ":" + *c.Job.RunnerID
	}
	spec.Metadata = map[string]string{"repo": c.Job.RepoID, "change": ch.ID, "agent_version": fmt.Sprintf("%s@v%d", agent.Agent, agent.Version),
		"person": person, "job": c.Job.ID}
	var out any
	var err error
	var eg *api.Egress
	var unsigned bool
	var pushed api.Report   // a push's writes and reads
	var reviewed api.Report // a review's verdict, sent once usage and limits are checked
	switch c.Job.Kind {
	case "review":
		reviewed, err = reviewChange(ctx, client, c.Job.ID, ch.Intent, agent.Egress, spec, &used)
	case "develop":
		var runner string
		if c.Job.RunnerID != nil {
			runner = *c.Job.RunnerID
		}
		spec.Prompt = ch.Intent
		var d developed
		var check edits.Checker
		if client != nil {
			check = func(ctx context.Context, base string, writes []symbols.Write, reads []string) ([]edits.Diagnostic, error) {
				return client.CheckEdit(ctx, c.Job.ID, base, writes, reads)
			}
		}
		d, err = develop(ctx, tok, fork, branch, runner, c.Attempts, agent.Egress, agent.EgressMode == "audit", spec, check)
		out, eg, pushed.Writes, pushed.Reads = d, d.Egress, d.Writes, d.Reads
		used = harness.Result{CostUSD: d.CostUSD, Tokens: d.Tokens}
	case "commit":
		pushed.Writes, pushed.Reads, err = commitEdit(ctx, tok, fork, branch, p.Path, p.Content, p.Thread)
	case "converge":
		var conflict *api.Conflict
		out, conflict, err = converge(ctx, tok, read, fork, target, branch)
		if conflict != nil {
			return api.Report{Status: "failed", Detail: "converge conflict", Conflict: conflict}
		}
	case "merge":
		var sign func(string) (string, error)
		if client != nil {
			sign = func(commit string) (string, error) {
				sig, err := client.SignMerge(ctx, c.Job.ID, commit)
				unsigned = err == nil && sig == ""
				return sig, err
			}
		}
		out, err = merge(ctx, tok, target, branch, p.Batch, agent.Agent, agent.Version, sign)
	case "resolve":
		out, err = resolveConflict(ctx, tok, read, fork, target, branch, p.resolvePayload, agent.Egress, spec, &used, &pushed)
	case "release":
		out, err = release(ctx, tok, p.Remote, p.Name, p.Draft)
	case "history":
		err = writeHistory(ctx, tok, target, p.Ref, p.Files)
	default:
		return api.Report{Status: "failed", Detail: "cinder-agent: no handler for " + c.Job.Kind + " jobs"}
	}
	// Only an agent run's error is a model run's; a git or release failure isn't.
	runErr := err
	if c.Job.Kind != "develop" && c.Job.Kind != "review" && c.Job.Kind != "resolve" {
		runErr = nil
	}
	reportUsage(ctx, c.Job.ID, spec, used, runErr)
	if max := agent.Limits.MaxSpend; max > 0 && used.CostUSD > max {
		return api.Report{Status: "failed", Detail: "max spend reached", Egress: eg}
	}
	// lazy: checked after the run, as no harness takes a token cap; a run can overshoot by its last turn.
	if l := agent.Limits; used.Tokens > 0 && (l.MaxTokens > 0 && used.Tokens > l.MaxTokens || l.MaxTokensMonth > 0 && l.TokensMonth+used.Tokens > l.MaxTokensMonth) {
		return api.Report{Status: "failed", Detail: "max tokens reached", Egress: eg}
	}
	if err != nil {
		return api.Report{Status: "failed", Detail: err.Error(), Egress: eg}
	}
	if reviewed.Status != "" {
		return reviewed
	}
	if out == nil {
		return api.Report{Status: "done", Writes: pushed.Writes, Reads: pushed.Reads}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return api.Report{Status: "failed", Detail: err.Error()}
	}
	// The Worker records a merge's commit (change_merged_shas) so the push event it sees afterwards is known as the
	// merge; without it a push event that arrives after this report looks like a direct push and is rolled back.
	var merged string
	if c.Job.Kind == "merge" {
		merged, _ = out.(string)
	}
	return api.Report{Status: "done", Detail: string(b), Egress: eg, Unsigned: unsigned, Writes: pushed.Writes, Reads: pushed.Reads, MergedSHA: merged}
}

// editHook posts the hook event on stdin to the gate at url and prints its answer.
func editHook(url string) error {
	resp, err := http.Post(url, "application/json", os.Stdin)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("status %d: %s", resp.StatusCode, b)
	}
	_, err = io.Copy(os.Stdout, resp.Body)
	return err
}

// reportUsage posts a harness run's tokens and cost to Model access for job; the Worker records them against the job's
// requester, with runErr when the run failed. A run that used nothing and didn't fail, or no Worker, posts nothing; a
// failed post is logged and never fails the job.
func reportUsage(ctx context.Context, job string, s harness.Spec, r harness.Result, runErr error) {
	if client == nil || (r.Tokens == 0 && r.CostUSD == 0 && runErr == nil) {
		return
	}
	provider, source := "anthropic", "org"
	switch s.Harness {
	case "codex":
		provider = "openai"
	case "opencode":
		provider, _, _ = strings.Cut(harness.OpencodeModel(s.Model), "/")
	}
	if provider == "workers-ai" {
		provider, source = "cf", "credits"
	}
	body := map[string]any{"job": job, "provider": provider, "source": source, "tokens": r.Tokens, "cost_usd": r.CostUSD}
	if runErr != nil {
		body["error"] = runErr.Error()
	}
	err := client.Post(ctx, "/api/work/model-usage", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cinder-agent: model usage:", err)
	}
}
