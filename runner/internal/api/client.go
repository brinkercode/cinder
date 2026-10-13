// Package api is the runner's client for the cinder Worker API.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"time"

	"github.com/brinkercode/cinder/runner/internal/edits"
	"github.com/brinkercode/cinder/runner/internal/guard"
	"github.com/brinkercode/cinder/runner/internal/mergeprobe"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

// Job is the contract's Job shape (validateJob in worker/src/api/contract.js).
type Job struct {
	ID             string  `json:"id"`
	RepoID         string  `json:"repo_id"`
	Kind           string  `json:"kind"`
	ChangeID       *string `json:"change_id"`
	Status         string  `json:"status"`
	RunnerID       *string `json:"runner_id"`
	LeaseExpiresAt *string `json:"lease_expires_at"`
	CreatedAt      string  `json:"created_at"`
}

// Secret hides a token from fmt (%v, %s) so it cannot reach a log by accident.
type Secret string

func (Secret) String() string { return "[redacted]" }

// Attempt is one earlier run of the claimed job's change, so any runner can pick it up.
type Attempt struct {
	Runner    string `json:"runner"`
	SessionID string `json:"session_id"`
	Summary   string `json:"summary"`
	LogTail   string `json:"log_tail"` // tail of the attempt's verdict log
}

// Change is the part of the contract's Change shape a runner needs.
type Change struct {
	ID           string `json:"id"`
	Intent       string `json:"intent"`
	TargetBranch string `json:"target_branch"`
}

// Claim is the contract's Claim shape (worker/src/api/shapes/claim.js): a claimed job, the Artifacts
// tokens scoped to it, its change and the git remotes of the change's fork and target, and the change's
// prior attempts, oldest first. Change and the remotes are empty for a job with no change.
type Claim struct {
	Job                      Job
	Change                   *Change
	GitToken, ReadToken      Secret
	ForkRemote, TargetRemote string
	Attempts                 []Attempt
	Payload                  json.RawMessage // the job's kind-specific payload, decoded by whoever runs that kind
	Agent                    *Agent          // the agent version the job runs as; nil when none resolves
	Egress                   PoolEgress      // the runner's pool egress, which flow steps run under
}

// PoolEgress is a Claim's egress: mode allowlist allows Allow's host patterns (path.Match syntax), none allows no
// extra host, open allows every host and records those outside Allow as would-deny.
type PoolEgress struct {
	Mode  string   `json:"mode"`
	Allow []string `json:"allow"`
}

// Agent is a Claim's agent: the release lock of the version a job runs as.
type Agent struct {
	Agent   string   `json:"agent"`
	Version int      `json:"version"`
	Harness string   `json:"harness"`
	Model   string   `json:"model"`
	Egress  []string `json:"egress"` // host patterns the harness may reach
	// EgressMode: enforce refuses hosts outside Egress; audit lets them through and reports them as would_deny.
	EgressMode string `json:"egress_mode"`
	Prompt     string `json:"prompt"` // the version's prompt.md; "" runs the harness without a system prompt
	Limits     struct {
		MaxSpend   float64 `json:"max_spend"` // USD; 0 is no limit
		MaxRepairs int     `json:"max_repairs"`
		MaxTokens  int64   `json:"max_tokens"`  // per run; 0 is no limit
		MaxMinutes int     `json:"max_minutes"` // the run's wall-clock limit; 0 leaves the runner's MaxJob
		// MaxTokensMonth caps the version's tokens per UTC calendar month (0 is no limit); TokensMonth is this month's so far.
		MaxTokensMonth int64 `json:"max_tokens_month"`
		TokensMonth    int64 `json:"tokens_month"`
	} `json:"limits"`
}

// ChangeIntent is one of theirs in converge and resolve job payloads: another change and its intent
// (validateConvergePayload in worker/src/api/shapes/converge-payload.js).
type ChangeIntent struct {
	ID     string `json:"id"`
	Intent string `json:"intent"`
}

// Report is the one result a runner sends per job.
type Report struct {
	Status  string       `json:"status"` // "done", "failed" or "cancelled"
	Detail  string       `json:"detail,omitempty"`
	Results string       `json:"results,omitempty"` // the job's test result file, when it wrote one
	Tests   []TestResult `json:"tests,omitempty"`   // Results parsed per test
	// MirrorFailed: a merge landed but its push to the repo's mirror_url failed.
	MirrorFailed bool `json:"mirror_failed,omitempty"`
	// Unsigned: a merge landed without a signature because the Worker had no signing key.
	Unsigned bool `json:"unsigned,omitempty"`
	// Tree: the tree a verify checked out and checked (its speculative tree when changes were ahead of it).
	Tree string `json:"tree,omitempty"`
	// Base: the target sha a verify merged the change onto; a merge refuses once the target moved past it.
	Base string `json:"base,omitempty"`
	// MergedSHA: the commit a merge left the target branch at.
	MergedSHA string `json:"merged_sha,omitempty"`
	// Refs: a refs job's branch names, from git ls-remote --heads.
	Refs []string `json:"refs,omitempty"`
	// Diff: a guard job's pushed diff, which the Worker's judge reads.
	Diff string `json:"diff,omitempty"`
	// Conflict: a converge whose merge-tree probe found conflicts; the Worker records it as the conflict object.
	Conflict *Conflict `json:"conflict,omitempty"`
	// Findings: SARIF results the check produced on lines the change touched; each is a merge blocker.
	Findings []Finding `json:"findings,omitempty"`
	// Verdict: a review's decided "pass" or "fail"; empty when the review never reached one (a crash).
	Verdict string `json:"verdict,omitempty"`
	// Secrets and Deps: a scan job's secrets in the target's tree and every dependency in its lockfiles.
	Secrets []guard.Finding `json:"secrets,omitempty"`
	Deps    []guard.Dep     `json:"deps,omitempty"`
	// Egress: CONNECTs per host through the job's egress proxy (hosts and counts only).
	Egress *Egress `json:"egress,omitempty"`
	// Writes and Reads: the symbols a push (develop, commit, resolve) or a verify's final diff wrote and read; the
	// Worker checks writes against the change's lease.
	Writes []symbols.Write `json:"writes,omitempty"`
	Reads  []string        `json:"reads,omitempty"`
	// DurationMS, Tokens ([in, out, cache]) and CostUSD: what the job took; the Worker records them on the change's stage.
	DurationMS int64     `json:"duration_ms,omitempty"`
	Tokens     *[3]int64 `json:"tokens,omitempty"`
	CostUSD    float64   `json:"cost_usd,omitempty"`
}

// Egress is a job's egress proxy counts, host to number of CONNECTs.
type Egress struct {
	Allowed map[string]int `json:"allowed"`
	Denied  map[string]int `json:"denied"`
	// WouldDeny: audit mode's CONNECTs to hosts outside the version's egress, let through.
	WouldDeny map[string]int `json:"would_deny"`
}

// Finding is one SARIF result on a changed line, or (Path and Body) a reviewer agent's line comment.
type Finding struct {
	Rule string `json:"rule,omitempty"`
	File string `json:"file,omitempty"`
	Path string `json:"path,omitempty"`
	Body string `json:"body,omitempty"`
	Line int    `json:"line"`
	// Severity and Fingerprint are set only by ingest-sarif (verify.Ingest).
	Severity    string `json:"severity,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// Conflict lists the conflicted paths and one hunk per path with its probe details.
type Conflict struct {
	Files []string          `json:"files"`
	Hunks []mergeprobe.File `json:"hunks"`
}

// TestResult is one test's outcome in a verify; the Worker stores it in D1 test_runs.
type TestResult struct {
	Test     string  `json:"test"`
	Status   string  `json:"status"`   // "pass", "fail" or "skip"
	Duration float64 `json:"duration"` // seconds
}

// Client calls the Worker's runner routes (/api/work/*) with the runner token, which identifies the runner.
type Client struct {
	BaseURL, Token string
}

// ErrUnauthorized means the pool token was rejected (revoked or wrong); retrying cannot succeed.
var ErrUnauthorized = errors.New("pool token unauthorized")

// Claim asks for a job. It returns nil, nil when the queue is empty (204).
func (c *Client) Claim(ctx context.Context) (*Claim, error) {
	var body struct {
		Job          json.RawMessage `json:"job"`
		Change       *Change         `json:"change"`
		Token        string          `json:"token"`
		ReadToken    string          `json:"read_token"`
		ForkRemote   string          `json:"fork_remote"`
		TargetRemote string          `json:"target_remote"`
		Attempts     []Attempt       `json:"attempts"`
		Payload      json.RawMessage `json:"payload"`
		Agent        *Agent          `json:"agent"`
		Egress       PoolEgress      `json:"egress"`
	}
	status, err := c.post(ctx, "/api/work/claim", nil, &body)
	if status == http.StatusUnauthorized {
		return nil, fmt.Errorf("claim: %w", ErrUnauthorized)
	}
	if err != nil || status == http.StatusNoContent {
		return nil, err
	}
	job, err := DecodeJob(body.Job)
	if err != nil {
		return nil, fmt.Errorf("claim: %w", err)
	}
	return &Claim{Job: job, Change: body.Change, GitToken: Secret(body.Token), ReadToken: Secret(body.ReadToken),
		ForkRemote: body.ForkRemote, TargetRemote: body.TargetRemote, Attempts: body.Attempts, Payload: body.Payload, Agent: body.Agent, Egress: body.Egress}, nil
}

// Beat is a heartbeat's answer: Cancel once the job is superseded and must be killed, and a change job's fresh
// tokens (empty for other kinds), which replace the claim's before those expire.
type Beat struct {
	Cancel           bool
	Token, ReadToken Secret
}

// Heartbeat extends the lease on a claimed job.
func (c *Client) Heartbeat(ctx context.Context, jobID string) (Beat, error) {
	var body struct {
		Cancel    bool   `json:"cancel"`
		Token     string `json:"token"`
		ReadToken string `json:"read_token"`
	}
	_, err := c.post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/heartbeat", nil, &body)
	return Beat{Cancel: body.Cancel, Token: Secret(body.Token), ReadToken: Secret(body.ReadToken)}, err
}

// Activity tells the Worker what job's agent is doing now, e.g. "editing <path>"; the board shows it live.
func (c *Client) Activity(ctx context.Context, jobID, activity, path string) error {
	_, err := c.post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/activity", map[string]string{"activity": activity, "path": path}, nil)
	return err
}

// Report sends the job's result.
func (c *Client) Report(ctx context.Context, jobID string, r Report) error {
	_, err := c.post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/report", r, nil)
	return err
}

// SignMerge returns the Worker's armored SSH signature (namespace git) of commit, a git commit object, by the repo's
// merge-signing key, or "" while the Worker has no signing key (the merge then lands unsigned). Only the runner
// holding the merge job's lease may ask.
func (c *Client) SignMerge(ctx context.Context, jobID, commit string) (string, error) {
	var body struct {
		Signature string `json:"signature"`
	}
	if _, err := c.post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/sign", map[string]string{"commit": commit}, &body); err != nil {
		return "", err
	}
	return body.Signature, nil
}

// Step records one step of a claimed flow job: its status (queued, running, passed, failed, skipped) and log tail.
// missing names the step secrets it could not read.
func (c *Client) Step(ctx context.Context, jobID, name, status, logs string, missing ...string) error {
	body := map[string]any{"name": name, "status": status, "logs": logs}
	if len(missing) > 0 {
		body["missing_secrets"] = missing
	}
	_, err := c.post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/steps", body, nil)
	return err
}

// StepStatus records step idx of a claimed flow job: running, then its final status (passed, failed, skipped or
// cancelled) with the exit code of its command, nil when none ran.
func (c *Client) StepStatus(ctx context.Context, jobID string, idx int, status string, exitCode *int) error {
	_, err := c.post(ctx, fmt.Sprintf("/api/work/jobs/%s/steps/%d/status", url.PathEscape(jobID), idx), map[string]any{"status": status, "exit_code": exitCode}, nil)
	return err
}

// LogLine is one whole line of a step's output and when the runner read it.
type LogLine struct {
	At   string `json:"at"`
	Text string `json:"text"`
}

// SeqConflict is a log batch the Worker refused as out of order (409); Expected is the seq it takes next.
type SeqConflict struct{ Expected int }

func (e SeqConflict) Error() string {
	return fmt.Sprintf("log batch out of order: expected seq %d", e.Expected)
}

// StepLog appends batch seq (1 for a step's first) of lines to step idx's log. An out-of-order seq returns SeqConflict.
func (c *Client) StepLog(ctx context.Context, jobID string, idx, seq int, lines []LogLine) error {
	_, err := c.post(ctx, fmt.Sprintf("/api/work/jobs/%s/steps/%d/log", url.PathEscape(jobID), idx), map[string]any{"seq": seq, "lines": lines}, nil)
	return err
}

// Annotation is an ##[error] or ##[warning] a step printed on its Line (counted from 0 in the step's log).
type Annotation struct {
	Step     string `json:"step"`
	Level    string `json:"level"`
	Message  string `json:"message"`
	File     string `json:"file,omitempty"`
	FileLine int    `json:"file_line,omitempty"`
	Line     int    `json:"line"`
}

// Annotations records a claimed flow job's annotations.
func (c *Client) Annotations(ctx context.Context, jobID string, a []Annotation) error {
	_, err := c.post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/annotations", a, nil)
	return err
}

// DriveStep hands a claimed flow job's deploy, cloudflare/workflow or approval step to the Worker, which starts it on
// the first call; each call returns the step's status (running, passed, failed) and what it is waiting on.
func (c *Client) DriveStep(ctx context.Context, jobID, name string) (status, logs string, err error) {
	var body struct{ Status, Logs string }
	_, err = c.post(ctx, "/api/work/jobs/"+url.PathEscape(jobID)+"/steps/"+url.PathEscape(name)+"/start", nil, &body)
	return body.Status, body.Logs, err
}

// JobSecret reads one keystore secret in scope for a claimed job, from Secrets Store through the Worker.
func (c *Client) JobSecret(ctx context.Context, jobID, name string) (Secret, error) {
	var body struct{ Value string }
	_, err := c.send(ctx, http.MethodGet, "/api/work/jobs/"+url.PathEscape(jobID)+"/secrets/"+url.PathEscape(name), nil, &body)
	return Secret(body.Value), err
}

// Put sends a job's result to its runner route (symbols, authorship or compare).
func (c *Client) Put(ctx context.Context, path string, body any) error {
	_, err := c.send(ctx, http.MethodPut, path, body, nil)
	return err
}

// CheckEdit checks the writes and reads of job's edits on base against the lease map (POST /api/work/edit-check).
func (c *Client) CheckEdit(ctx context.Context, job, base string, writes []symbols.Write, reads []string) ([]edits.Diagnostic, error) {
	var out struct {
		Diagnostics []edits.Diagnostic `json:"diagnostics"`
	}
	_, err := c.post(ctx, "/api/work/edit-check", map[string]any{"job": job, "base_sha": base, "writes": writes, "reads": reads}, &out)
	return out.Diagnostics, err
}

// Post sends a runner report that answers no body (model usage).
func (c *Client) Post(ctx context.Context, path string, body any) error {
	_, err := c.post(ctx, path, body, nil)
	return err
}

func (c *Client) post(ctx context.Context, path string, body, out any) (int, error) {
	return c.send(ctx, http.MethodPost, path, body, out)
}

// httpClient bounds every call to the Worker: one that never answers would otherwise block its job forever while the
// heartbeat keeps the lease alive. Five minutes covers an artifact upload (100 MB at most).
var httpClient = &http.Client{Timeout: 5 * time.Minute}

// send sends body as JSON and decodes a 200 response into out. Errors carry the
// path and status only, never the request, so the API token can't leak through them.
func (c *Client) send(ctx context.Context, method, path string, body, out any) (int, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return 0, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, &buf)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	SetAccess(req.Header)
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		// The Worker's {error: {code, message}} says why (e.g. a 409 report: already_reported, change_moved, lease_lost).
		var e struct {
			Error       struct{ Code, Message string }
			ExpectedSeq int `json:"expected_seq"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if resp.StatusCode == http.StatusConflict && e.ExpectedSeq > 0 {
			return resp.StatusCode, SeqConflict{e.ExpectedSeq}
		}
		return resp.StatusCode, fmt.Errorf("%s: status %d: %s: %s", path, resp.StatusCode, e.Error.Code, e.Error.Message)
	}
	if out != nil && resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(out) != nil {
		return resp.StatusCode, fmt.Errorf("%s: response is not valid JSON", path)
	}
	return resp.StatusCode, nil
}

// SetAccess adds the Cloudflare Access service-token headers when CINDER_ACCESS_CLIENT_ID and
// CINDER_ACCESS_CLIENT_SECRET are both set. They only get the request through the edge; the bearer token identifies the caller.
func SetAccess(h http.Header) {
	id, secret := os.Getenv("CINDER_ACCESS_CLIENT_ID"), os.Getenv("CINDER_ACCESS_CLIENT_SECRET")
	if id == "" || secret == "" {
		return
	}
	h.Set("CF-Access-Client-Id", id)
	h.Set("CF-Access-Client-Secret", secret)
}

// DecodeJob parses raw and checks it against the contract's Job shape:
// every field present, strings non-empty, enums and timestamps valid.
func DecodeJob(raw json.RawMessage) (j Job, err error) {
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return Job{}, fmt.Errorf("job: expected object")
	}
	for _, r := range jobRules {
		if v, ok := fields[r.key]; !ok {
			return Job{}, fmt.Errorf("job.%s: required", r.key)
		} else if !r.ok(v) {
			return Job{}, fmt.Errorf("job.%s: invalid value %v", r.key, v)
		}
	}
	err = json.Unmarshal(raw, &j)
	return j, err
}

type rule = func(any) bool

func str(v any) bool   { s, ok := v.(string); return ok && s != "" }
func ts(v any) bool    { s, _ := v.(string); _, err := time.Parse(time.RFC3339, s); return err == nil }
func null(r rule) rule { return func(v any) bool { return v == nil || r(v) } }
func oneOf(l ...string) rule {
	return func(v any) bool { s, _ := v.(string); return slices.Contains(l, s) }
}

// jobRules mirrors validateJob and JOB_KINDS in worker/src/api/contract.js.
var jobRules = []struct {
	key string
	ok  rule
}{
	{"id", str}, {"repo_id", str},
	{"kind", oneOf("index", "develop", "verify", "converge", "merge", "resolve", "review",
		"seam", "split", "guard", "release", "history", "commit", "blame", "scan", "ingest-sarif", "refs", "compare", "flow")},
	{"change_id", null(str)}, {"status", oneOf("queued", "claimed", "done", "failed")},
	{"runner_id", null(str)}, {"lease_expires_at", null(ts)}, {"created_at", ts},
}
