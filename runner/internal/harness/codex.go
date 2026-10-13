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
	"slices"
	"strconv"
	"strings"
)

// runCodex runs `codex exec --json` with OpenAI model s.Model. codex reports tokens, not
// dollars, and has no budget flag: cost is tokens × CINDER_PROVIDER_OPENAI_PRICE (USD per
// million tokens), and a run that ends over s.MaxUSD is an error.
func runCodex(ctx context.Context, s Spec) (Result, error) {
	env := providerEnv("openai")
	price := -1.0 // unknown
	if p := os.Getenv(env + "_PRICE"); p != "" {
		var err error
		if price, err = strconv.ParseFloat(p, 64); err != nil || price < 0 {
			return Result{}, fmt.Errorf("codex: %s_PRICE %q is not a non-negative number", env, p)
		}
	}
	if s.MaxUSD > 0 && price < 0 {
		return Result{}, fmt.Errorf("codex: a budget needs %s_PRICE to price tokens", env)
	}
	args := []string{"exec", "--json", "--full-auto"}
	if s.Model != "" {
		args = append(args, "--model", s.Model)
	}
	if s.Effort != "" {
		args = append(args, "-c", "model_reasoning_effort="+s.Effort)
	}
	if s.Resume != "" {
		args = append(args, "resume", s.Resume)
	}
	var gwEnv []string
	if gw := gateway(); gw != "" {
		// codex's built-in openai provider can't take extra headers, so a gateway run defines its own provider that
		// sends CINDER_AIG_METADATA as cf-aig-metadata. Without a key the gateway (or models.internal) supplies it.
		provider := fmt.Sprintf(`{name="cinder",base_url=%q,wire_api="responses",env_http_headers={"cf-aig-metadata"="CINDER_AIG_METADATA"}`, gw+"/openai")
		if os.Getenv("OPENAI_API_KEY") != "" {
			provider += `,env_key="OPENAI_API_KEY"`
		}
		args = append(args, "-c", `model_provider="cinder"`, "-c", "model_providers.cinder="+provider+"}")
		gwEnv = []string{"CINDER_AIG_METADATA=" + metadataJSON(s.Metadata)}
	}
	cmd := exec.CommandContext(ctx, "codex", append(args, s.Prompt)...)
	cmd.Dir = s.Workdir
	cmd.Env = append(append(allowedEnv(slices.Concat(s.AllowEnv, []string{"OPENAI_API_KEY", "CODEX_API_KEY"})), s.Env...), gwEnv...)
	secrets := s.Secrets
	for _, k := range []string{"OPENAI_API_KEY", "CODEX_API_KEY"} {
		if v := os.Getenv(k); v != "" {
			secrets = append(secrets, v)
		}
	}
	out, stderr, runErr := run(cmd, secrets)

	// One JSON event per line; turn.completed carries usage, agent_message items the answer.
	var res Result
	var text strings.Builder
	var tokens int64
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(nil, 16<<20)
	for sc.Scan() {
		var ev struct {
			Type     string `json:"type"`
			ThreadID string `json:"thread_id"`
			Item     struct {
				Type, Text string
			} `json:"item"`
			Usage struct {
				Input  int64 `json:"input_tokens"`
				Output int64 `json:"output_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "thread.started":
			res.SessionID = ev.ThreadID
		case "item.completed":
			if ev.Item.Type == "agent_message" {
				text.WriteString(ev.Item.Text)
			}
		case "turn.completed":
			tokens += ev.Usage.Input + ev.Usage.Output
		}
	}
	if err := sc.Err(); err != nil {
		runErr = errors.Join(runErr, err)
	}
	res.Tokens = tokens
	if price >= 0 {
		res.CostUSD, res.CostKnown = float64(tokens)*price/1e6, true
	}
	res.Output, _ = json.Marshal(text.String()) // marshalling a string cannot fail
	if runErr != nil {
		return res, fmt.Errorf("codex: %w: %s", runErr, stderr)
	}
	if s.MaxUSD > 0 && res.CostUSD > s.MaxUSD {
		return res, fmt.Errorf("codex: cost $%g over budget $%g", res.CostUSD, s.MaxUSD)
	}
	return res, nil
}
