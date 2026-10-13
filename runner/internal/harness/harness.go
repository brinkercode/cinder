// Package harness runs an agent through an existing CLI harness, never a home-grown loop.
package harness

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/brinkercode/cinder/runner/internal/mask"
)

// Spec is one harness run. Zero values leave the harness default in place.
type Spec struct {
	Harness                        string // "opencode", "codex", "claude-code" or "" (claude-code); Run refuses any other
	Prompt, Workdir, Model, Effort string
	System                         string // the agent version's prompt; Prompt is then the task
	MaxUSD                         float64
	Resume                         string   // session id to continue
	OutputSchema                   string   // JSON Schema for the structured result
	Env                            []string // added to the runner's environment, e.g. the egress proxy
	AllowEnv                       []string // agent.yml `env:` names passed through; the rest is withheld
	Secrets                        []string // masked out of the harness's stdout and stderr
	// Metadata is cf-aig-metadata on the model calls when CINDER_AI_GATEWAY is set.
	Metadata map[string]string
	// Hook is the command claude-code runs before and after each edit and before it stops (edits.Gate.Hook); the
	// other harnesses have no edit hooks.
	Hook string
}

// harnessNeeds is what the harness itself needs from the runner's environment.
var harnessNeeds = []string{"PATH", "HOME", "TMPDIR", "LANG", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"}

// allowedEnv returns only harnessNeeds and names from the runner's environment: deny by default.
func allowedEnv(names []string) []string {
	env := []string{} // non-nil: a nil cmd.Env inherits the whole environment
	for _, n := range slices.Concat(harnessNeeds, names) {
		if v, ok := os.LookupEnv(n); ok {
			env = append(env, n+"="+v)
		}
	}
	return env
}

// Result is what the harness reports back.
type Result struct {
	CostUSD   float64
	CostKnown bool  // false when the harness reported no cost and no price is configured
	Tokens    int64 // input and output tokens the run used
	SessionID string
	Output    json.RawMessage // structured output when OutputSchema is set, else the text result
}

// ProviderHost is the host of the model provider the harness for s calls, "" when unknown.
func ProviderHost(s Spec) string {
	raw := cmp.Or(os.Getenv("CINDER_AI_GATEWAY"), "https://api.anthropic.com")
	if s.Harness == "opencode" {
		provider, _, _ := strings.Cut(OpencodeModel(s.Model), "/")
		raw, _ = providerEndpoint(provider)
	}
	if s.Harness == "codex" {
		raw = cmp.Or(os.Getenv("CINDER_AI_GATEWAY"), "https://api.openai.com")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// Run executes s with the adapter s.Harness names: `claude -p` (default), `opencode run` or
// `codex exec` from PATH, in s.Workdir.
func Run(ctx context.Context, s Spec) (Result, error) {
	if !slices.Contains([]string{"", "claude-code", "opencode", "codex"}, s.Harness) {
		return Result{}, fmt.Errorf("harness %s isn't supported by this runner", s.Harness)
	}
	if s.System != "" && (s.Harness == "opencode" || s.Harness == "codex") {
		// These CLIs take no system prompt, so the version's prompt leads the task.
		s.Prompt = s.System + "\n\n---\n\n" + s.Prompt
	}
	if s.Harness == "opencode" {
		return runOpencode(ctx, s)
	}
	if s.Harness == "codex" {
		return runCodex(ctx, s)
	}
	// Without a permission mode, -p denies edits and the run ends with nothing written.
	args := []string{"-p", s.Prompt, "--output-format", "json", "--permission-mode", "acceptEdits"}
	for _, f := range [][2]string{{"--model", s.Model}, {"--effort", s.Effort}, {"--system-prompt", s.System},
		{"--json-schema", s.OutputSchema}, {"--resume", s.Resume}} {
		if f[1] != "" {
			args = append(args, f[0], f[1])
		}
	}
	if s.Hook != "" {
		on := func(matcher string) []any {
			return []any{map[string]any{"matcher": matcher, "hooks": []any{map[string]string{"type": "command", "command": s.Hook}}}}
		}
		edit := "Edit|MultiEdit|Write"
		settings, _ := json.Marshal(map[string]any{"hooks": map[string]any{"PreToolUse": on(edit), "PostToolUse": on(edit), "Stop": on("")}}) // maps of strings always marshal
		args = append(args, "--settings", string(settings))
	}
	if s.MaxUSD > 0 {
		args = append(args, "--max-budget-usd", strconv.FormatFloat(s.MaxUSD, 'f', -1, 64))
	}
	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = s.Workdir
	cmd.Env = append(append(allowedEnv(s.AllowEnv), s.Env...), gatewayEnv(s.Metadata)...)
	out, stderr, runErr := run(cmd, s.Secrets)
	// claude prints its JSON result even when it exits non-zero (e.g. budget hit), so cost is kept.
	var r struct {
		IsError    bool            `json:"is_error"`
		Cost       float64         `json:"total_cost_usd"`
		SessionID  string          `json:"session_id"`
		Result     json.RawMessage `json:"result"`
		Structured json.RawMessage `json:"structured_output"`
		Usage      struct {
			Input  int64 `json:"input_tokens"`
			Output int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(out, &r); err != nil {
		return Result{}, errors.Join(runErr, fmt.Errorf("claude: output is not JSON: %s", stderr))
	}
	res := Result{CostUSD: r.Cost, CostKnown: true, Tokens: r.Usage.Input + r.Usage.Output, SessionID: r.SessionID, Output: r.Result}
	if len(r.Structured) > 0 {
		res.Output = r.Structured
	}
	// claude reports why it failed (an API error, a refused login) in its JSON result, and stderr may add more.
	if runErr != nil || r.IsError {
		why := string(r.Result)
		_ = json.Unmarshal(r.Result, &why) // a text result is a JSON string
		runErr = fmt.Errorf("claude: %w: %s %s", cmp.Or(runErr, errors.New("run failed")), why, bytes.TrimSpace(stderr))
	}
	return res, runErr
}

// gatewayEnv routes claude through the AI Gateway at CINDER_AI_GATEWAY (https://gateway.ai.cloudflare.com/v1/<account>/<gateway>)
// with meta as cf-aig-metadata, which the worker reads back from the gateway's logs (worker/src/usage.js). None when unset.
func gatewayEnv(meta map[string]string) []string {
	gw := gateway()
	if gw == "" {
		return nil
	}
	env := []string{"ANTHROPIC_BASE_URL=" + gw + "/anthropic"}
	if m := metadataJSON(meta); m != "" {
		env = append(env, "ANTHROPIC_CUSTOM_HEADERS=cf-aig-metadata: "+m)
	}
	return env
}

// gateway is CINDER_AI_GATEWAY without a trailing slash, "" when unset.
func gateway() string {
	return strings.TrimSuffix(os.Getenv("CINDER_AI_GATEWAY"), "/")
}

// metadataJSON is meta as a cf-aig-metadata value, "" when empty.
func metadataJSON(meta map[string]string) string {
	if len(meta) == 0 {
		return ""
	}
	b, _ := json.Marshal(meta) // a map[string]string always marshals
	return string(b)
}

// run executes cmd with its stdout and stderr masked for secrets before anyone reads them.
func run(cmd *exec.Cmd, secrets []string) (stdout, stderr []byte, err error) {
	var out, errOut bytes.Buffer
	mo, me := mask.New(&out), mask.New(&errOut)
	for _, v := range secrets {
		if err := mo.Add(v); err != nil {
			return nil, nil, err
		}
		_ = me.Add(v) // same value, already accepted
	}
	cmd.Stdout, cmd.Stderr = mo, me
	// On ctx cancel kill the harness's whole process group, so no tool it spawned outlives the job.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	err = cmd.Run()
	_, _ = mo.Close(), me.Close() // flushing into a bytes.Buffer cannot fail
	return out.Bytes(), errOut.Bytes(), err
}
