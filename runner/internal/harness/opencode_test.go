package harness

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeOpencode puts an `opencode` on PATH that records argv and its config env, and
// prints a step with 1000 tokens and no provider cost.
func fakeOpencode(t *testing.T) (record string) {
	bin := t.TempDir()
	record = filepath.Join(bin, "record")
	script := "#!/bin/sh\n{ printf '%s\\n' \"$@\"; printf '%s\\n' \"$OPENCODE_CONFIG_CONTENT\"; } > " + record + "\n" +
		`echo '{"type":"text","sessionID":"ses-1","part":{"text":"done"}}'` + "\n" +
		`echo '{"type":"step_finish","sessionID":"ses-1","part":{"cost":0,"tokens":{"input":600,"output":300,"reasoning":100}}}'` + "\n"
	if err := os.WriteFile(filepath.Join(bin, "opencode"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CINDER_PROVIDER_OLLAMA_URL", "http://lab:11434/v1")
	return record
}

func TestRunOpencode_FakeBinary_GetsBaseURLAndModel(t *testing.T) {
	record := fakeOpencode(t)
	t.Setenv("CINDER_PROVIDER_OLLAMA_PRICE", "2")
	res, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "fix it", Model: "ollama/qwen3-coder", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	got := "\n" + string(b)
	for _, want := range []string{"\nrun\n", "\n--model\nollama/qwen3-coder\n", "\nfix it\n", `"baseURL":"http://lab:11434/v1"`, `"qwen3-coder":{"limit":{"context":32768,"output":8192}}`} {
		if !strings.Contains(got, want) {
			t.Fatalf("recorded %q, want %q", got, want)
		}
	}
	if res.SessionID != "ses-1" || string(res.Output) != `"done"` || !res.CostKnown || res.CostUSD != 0.002 {
		t.Fatalf("result = %+v, want session ses-1, output done, cost 1000 tokens × $2/M = 0.002 known", res)
	}
}

func TestRunOpencode_MissingPrice_RecordsCostKnownFalse(t *testing.T) {
	fakeOpencode(t)
	res, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "fix it", Model: "ollama/qwen3-coder", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if res.CostKnown || res.CostUSD != 0 {
		t.Fatalf("result = %+v, want cost 0 with cost_known=false", res)
	}
}

func assertOpencodeGateway(t *testing.T) {
	t.Helper()
	record := fakeOpencode(t)
	t.Setenv("CINDER_AI_GATEWAY", "https://gateway.ai.cloudflare.com/v1/acct/cinder/")
	t.Setenv("CLOUDFLARE_API_TOKEN", "cf-secret")
	model := "workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct"
	if _, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "fix it", Model: model, Workdir: t.TempDir(), Metadata: map[string]string{"change": "c-1"}}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	got := "\n" + string(b)
	for _, want := range []string{"\n--model\n" + model + "\n", `"baseURL":"https://gateway.ai.cloudflare.com/v1/acct/cinder/workers-ai/v1"`,
		`"headers":{"cf-aig-metadata":"{\"change\":\"c-1\"}"}`, `"apiKey":""`, `"@cf/qwen/qwen2.5-coder-32b-instruct":{"limit":{"context":32768,"output":8192}}`} {
		if !strings.Contains(got, want) {
			t.Fatalf("recorded %q, want %q", got, want)
		}
	}
	if strings.Contains(got, "cf-secret") {
		t.Fatalf("recorded %q, want no CLOUDFLARE_API_TOKEN", got)
	}
	if h := ProviderHost(Spec{Harness: "opencode", Model: model}); h != "gateway.ai.cloudflare.com" {
		t.Fatalf("ProviderHost = %q, want the gateway host", h)
	}
}

func TestRunOpencode_WorkersAI_NoGateway_FailsBeforeStart(t *testing.T) {
	record := fakeOpencode(t)
	t.Setenv("CINDER_AI_GATEWAY", "")
	_, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "fix it", Model: "workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct", Workdir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "CINDER_AI_GATEWAY") {
		t.Fatalf("err = %v, want one naming CINDER_AI_GATEWAY", err)
	}
	if _, statErr := os.Stat(record); !os.IsNotExist(statErr) {
		t.Fatalf("opencode started (record exists: %v), want it never run", statErr)
	}
}

func TestOpencode_WorkersAICatalogModel_UsesGateway(t *testing.T) {
	record := fakeOpencode(t)
	t.Setenv("CINDER_AI_GATEWAY", "http://models.internal")
	model := "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
	if _, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "fix it", Model: model, Workdir: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	got := "\n" + string(b)
	for _, want := range []string{"\n--model\nworkers-ai/" + model + "\n", `"baseURL":"http://models.internal/workers-ai/v1"`, `"workers-ai":{`, `"` + model + `":{"limit":{"context":32768,"output":8192}}`} {
		if !strings.Contains(got, want) {
			t.Fatalf("recorded %q, want %q", got, want)
		}
	}
	if h := ProviderHost(Spec{Harness: "opencode", Model: model}); h != "models.internal" {
		t.Fatalf("ProviderHost = %q, want the gateway host", h)
	}
}

func TestOpencode_UnknownProviderStillNeedsItsURL(t *testing.T) {
	record := fakeOpencode(t)
	t.Setenv("CINDER_AI_GATEWAY", "http://models.internal")
	// The gateway serves catalog models only: with it set, a catalog model runs and another provider still needs its URL.
	if _, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "fix it", Model: "@cf/meta/llama-3.1-8b-instruct-fast", Workdir: t.TempDir()}); err != nil {
		t.Fatalf("catalog model: %v", err)
	}
	if err := os.Remove(record); err != nil {
		t.Fatal(err)
	}
	_, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "fix it", Model: "acme/coder-1", Workdir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "CINDER_PROVIDER_ACME_URL is not set") {
		t.Fatalf("err = %v, want one naming CINDER_PROVIDER_ACME_URL", err)
	}
	if _, statErr := os.Stat(record); !os.IsNotExist(statErr) {
		t.Fatalf("opencode started (record exists: %v), want it never run", statErr)
	}
}

func TestRunOpencode_ErrorEvent_ReachesTheFailure(t *testing.T) {
	bin := t.TempDir()
	script := "#!/bin/sh\n" + `echo '{"type":"error","sessionID":"ses-1","error":{"name":"APIError","data":{"message":"Bad Request: model not found"}}}'` + "\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "opencode"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CINDER_PROVIDER_OLLAMA_URL", "http://lab:11434/v1")
	_, err := Run(context.Background(), Spec{Harness: "opencode", Prompt: "x", Model: "ollama/m", Workdir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "APIError: Bad Request: model not found") {
		t.Fatalf("err = %v, want opencode's error event in it", err)
	}
}
