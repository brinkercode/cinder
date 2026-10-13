package harness

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// modelLimit is what opencode is told of a model it has no metadata for. Without it opencode asks for 32k output tokens
// on top of the input, which a 32k-context model refuses (ContextOverflowError) before any work starts.
// lazy: one floor for every model (the smallest catalog coding model's window); carry each model's window in the job spec if a bigger one needs it.
var modelLimit = map[string]int{"context": 32768, "output": 8192}

// providerEnv is the environment variable prefix for provider's settings.
func providerEnv(provider string) string {
	return "CINDER_PROVIDER_" + strings.ToUpper(strings.ReplaceAll(provider, "-", "_"))
}

// providerEndpoint is provider's OpenAI-compatible base URL and API key. workers-ai is built in:
// Cloudflare Workers AI through the AI Gateway at CINDER_AI_GATEWAY, which authenticates the call itself.
func providerEndpoint(provider string) (baseURL, key string) {
	if provider == "workers-ai" {
		if gw := gateway(); gw != "" {
			return gw + "/workers-ai/v1", ""
		}
		return "", ""
	}
	env := providerEnv(provider)
	return os.Getenv(env + "_URL"), os.Getenv(env + "_KEY")
}

// OpencodeModel is m as "<provider>/<model>": a bare Workers AI catalog model ("@cf/...")
// belongs to the built-in workers-ai provider.
func OpencodeModel(m string) string {
	if strings.HasPrefix(m, "@cf/") {
		return "workers-ai/" + m
	}
	return m
}

// runOpencode runs `opencode run` against an OpenAI-compatible endpoint. s.Model is
// "<provider>/<model>"; the runner maps the provider through its environment:
// CINDER_PROVIDER_<NAME>_URL (required), _KEY and _PRICE (USD per million tokens), except
// workers-ai, which requires CINDER_AI_GATEWAY (see providerEndpoint).
func runOpencode(ctx context.Context, s Spec) (Result, error) {
	s.Model = OpencodeModel(s.Model)
	provider, model, ok := strings.Cut(s.Model, "/")
	if !ok || provider == "" || model == "" {
		return Result{}, fmt.Errorf("opencode: model %q is not provider/model", s.Model)
	}
	env := providerEnv(provider)
	baseURL, key := providerEndpoint(provider)
	if provider == "workers-ai" && baseURL == "" {
		return Result{}, errors.New("opencode: provider workers-ai needs CINDER_AI_GATEWAY in the runner env")
	}
	if baseURL == "" {
		return Result{}, fmt.Errorf("opencode: %s_URL is not set", env)
	}
	price := -1.0 // unknown
	if p := os.Getenv(env + "_PRICE"); p != "" {
		var err error
		if price, err = strconv.ParseFloat(p, 64); err != nil || price < 0 {
			return Result{}, fmt.Errorf("opencode: %s_PRICE %q is not a non-negative number", env, p)
		}
	}
	// The key travels in the config env var, never on argv.
	options := map[string]any{"baseURL": baseURL, "apiKey": key}
	if m := metadataJSON(s.Metadata); m != "" && provider == "workers-ai" {
		options["headers"] = map[string]string{"cf-aig-metadata": m}
	}
	cfg, err := json.Marshal(map[string]any{"provider": map[string]any{provider: map[string]any{
		"npm":     "@ai-sdk/openai-compatible",
		"options": options,
		"models":  map[string]any{model: map[string]any{"limit": modelLimit}},
	}}})
	if err != nil {
		return Result{}, err
	}
	args := []string{"run", "--format", "json", "--auto", "--model", s.Model}
	if s.Resume != "" {
		args = append(args, "--session", s.Resume)
	}
	cmd := exec.CommandContext(ctx, "opencode", append(args, s.Prompt)...)
	cmd.Dir = s.Workdir
	cmd.Env = append(append(allowedEnv(s.AllowEnv), s.Env...), "OPENCODE_CONFIG_CONTENT="+string(cfg))
	secrets := s.Secrets
	if key != "" {
		secrets = append(secrets, key)
	}
	out, stderr, runErr := run(cmd, secrets)

	// One JSON event per line; step_finish carries usage, text carries the answer.
	var res Result
	var text, failed strings.Builder
	var tokens int64
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(nil, 16<<20)
	for sc.Scan() {
		var ev struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
			Part      struct {
				Text   string  `json:"text"`
				Cost   float64 `json:"cost"`
				Tokens struct {
					Input, Output, Reasoning int64
				} `json:"tokens"`
			} `json:"part"`
			Error struct {
				Name string `json:"name"`
				Data struct {
					Message string `json:"message"`
				} `json:"data"`
			} `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		if ev.SessionID != "" {
			res.SessionID = ev.SessionID
		}
		switch ev.Type {
		case "text":
			text.WriteString(ev.Part.Text)
		case "error":
			// opencode reports a failed model call as an event on stdout, not on stderr.
			fmt.Fprintf(&failed, "%s: %s\n", ev.Error.Name, ev.Error.Data.Message)
		case "step_finish":
			res.CostUSD += ev.Part.Cost
			tokens += ev.Part.Tokens.Input + ev.Part.Tokens.Output + ev.Part.Tokens.Reasoning
		}
	}
	if err := sc.Err(); err != nil {
		runErr = errors.Join(runErr, err)
	}
	res.Tokens = tokens
	switch {
	case res.CostUSD > 0:
		res.CostKnown = true
	case price >= 0:
		res.CostUSD, res.CostKnown = float64(tokens)*price/1e6, true
	}
	res.Output, _ = json.Marshal(text.String()) // marshalling a string cannot fail
	if runErr != nil {
		runErr = fmt.Errorf("opencode: %w: %s%s", runErr, failed.String(), stderr)
	}
	return res, runErr
}
