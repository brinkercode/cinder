package harness

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunCodex_FakeBinary_MapsModelAndParsesCost(t *testing.T) {
	bin := t.TempDir()
	record := filepath.Join(bin, "record")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + record + "\n" +
		`echo '{"type":"thread.started","thread_id":"th-1"}'` + "\n" +
		`echo '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"done"}}'` + "\n" +
		`echo '{"type":"turn.completed","usage":{"input_tokens":700,"cached_input_tokens":200,"output_tokens":300}}'` + "\n"
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CINDER_PROVIDER_OPENAI_PRICE", "2")

	res, err := Run(context.Background(), Spec{Harness: "codex", Prompt: "fix it", Model: "gpt-5-codex", Effort: "high", MaxUSD: 1, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	got := "\n" + string(b)
	for _, want := range []string{"\nexec\n--json\n", "\n--model\ngpt-5-codex\n", "\nmodel_reasoning_effort=high\n", "\nfix it\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("recorded %q, want %q", got, want)
		}
	}
	if res.SessionID != "th-1" || string(res.Output) != `"done"` || !res.CostKnown || res.CostUSD != 0.002 {
		t.Fatalf("result = %+v, want session th-1, output done, cost 1000 tokens × $2/M = 0.002 known", res)
	}

	// The same run over a smaller budget is reported as over budget, cost kept.
	res, err = Run(context.Background(), Spec{Harness: "codex", Prompt: "fix it", Model: "gpt-5-codex", MaxUSD: 0.001, Workdir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "over budget") || res.CostUSD != 0.002 {
		t.Fatalf("err = %v, cost = %v, want over budget with cost 0.002", err, res.CostUSD)
	}
}

// One test for both harnesses: the codex launch, then opencode's workers-ai config, carry the gateway base URL and cf-aig-metadata.
func TestRunCodexAndOpencode_Gateway_CarryBaseURLAndMetadata(t *testing.T) {
	bin := t.TempDir()
	record := filepath.Join(bin, "record")
	script := "#!/bin/sh\n{ printf '%s\\n' \"$@\"; env; } > " + record + "\n"
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CINDER_AI_GATEWAY", "https://gateway.ai.cloudflare.com/v1/acct/cinder")
	t.Setenv("OPENAI_API_KEY", "")
	if _, err := Run(context.Background(), Spec{Harness: "codex", Prompt: "fix it", Workdir: t.TempDir(), Metadata: map[string]string{"change": "c-1"}}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	got := "\n" + string(b)
	for _, want := range []string{"\n-c\nmodel_provider=\"cinder\"\n", `base_url="https://gateway.ai.cloudflare.com/v1/acct/cinder/openai"`,
		`env_http_headers={"cf-aig-metadata"="CINDER_AIG_METADATA"}`, "\nCINDER_AIG_METADATA={\"change\":\"c-1\"}\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("recorded %q, want %q", got, want)
		}
	}
	if h := ProviderHost(Spec{Harness: "codex"}); h != "gateway.ai.cloudflare.com" {
		t.Fatalf("ProviderHost = %q, want the gateway host", h)
	}
	assertOpencodeGateway(t)
}
