package harness

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClaude puts a `claude` on PATH that records its argv and prints a result.
func fakeClaude(t *testing.T) (argsFile string) {
	bin := t.TempDir()
	argsFile = filepath.Join(bin, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argsFile +
		"\necho '{\"type\":\"result\",\"is_error\":false,\"total_cost_usd\":0.25,\"session_id\":\"sess-2\",\"result\":\"ok\"}'\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return argsFile
}

func runArgs(t *testing.T, s Spec) (Result, string) {
	argsFile := fakeClaude(t)
	s.Workdir = t.TempDir()
	res, err := Run(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	return res, "\n" + string(b)
}

func TestRun_Resume_PassesResumeFlag(t *testing.T) {
	res, args := runArgs(t, Spec{Prompt: "fix it", Resume: "sess-1"})
	if !strings.Contains(args, "\n--resume\nsess-1\n") {
		t.Fatalf("args = %q, want --resume sess-1", args)
	}
	if res.SessionID != "sess-2" || res.CostUSD != 0.25 {
		t.Fatalf("result = %+v, want session sess-2 cost 0.25", res)
	}
}

func TestRun_Budget_PassedAsMaxBudgetUSD(t *testing.T) {
	_, args := runArgs(t, Spec{Prompt: "fix it", Model: "opus", MaxUSD: 1.5})
	for _, want := range []string{"\n-p\nfix it\n", "\n--max-budget-usd\n1.5\n", "\n--model\nopus\n", "\n--output-format\njson\n"} {
		if !strings.Contains(args, want) {
			t.Fatalf("args = %q, want %q", args, want)
		}
	}
	if strings.Contains(args, "--resume") {
		t.Fatalf("args = %q, want no --resume on a fresh run", args)
	}
}

func TestRun_SetsPermissionMode(t *testing.T) {
	_, args := runArgs(t, Spec{Prompt: "fix it"})
	if !strings.Contains(args, "\n--permission-mode\nacceptEdits\n") {
		t.Fatalf("args = %q, want --permission-mode acceptEdits", args)
	}
}

func TestHarnessLog_TokenNeverUploaded(t *testing.T) {
	const token = "ghs_harnessSecretToken123"
	bin := t.TempDir()
	script := "#!/bin/sh\necho 'cloning with " + token + "' >&2\n" +
		"echo '{\"is_error\":true,\"session_id\":\"s\",\"result\":\"push failed for " + token + "\"}'\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	res, err := Run(context.Background(), Spec{Prompt: "fix it", Workdir: t.TempDir(), Secrets: []string{token}})
	if err == nil {
		t.Fatal("want the run's error")
	}
	if uploaded := err.Error() + string(res.Output); strings.Contains(uploaded, token) || !strings.Contains(uploaded, "***") {
		t.Fatalf("uploaded %q, want the token masked", uploaded)
	}
}

// fakeClaudeEnv runs s through a `claude` on PATH that records its environment.
func fakeClaudeEnv(t *testing.T, s Spec) string {
	bin := t.TempDir()
	envFile := filepath.Join(bin, "env")
	script := "#!/bin/sh\nenv > " + envFile + "\necho '{\"result\":\"ok\"}'\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CINDER_TEST_LISTED", "yes")
	t.Setenv("CINDER_TEST_UNLISTED", "secret")
	s.Workdir = t.TempDir()
	if _, err := Run(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	return "\n" + string(b)
}

func TestRun_EnvNotListed_AbsentInHarness(t *testing.T) {
	if env := fakeClaudeEnv(t, Spec{Prompt: "x", AllowEnv: []string{"CINDER_TEST_LISTED"}}); strings.Contains(env, "CINDER_TEST_UNLISTED") {
		t.Fatalf("harness env = %q, want CINDER_TEST_UNLISTED withheld", env)
	}
}

func TestRun_EnvListed_PassedThrough(t *testing.T) {
	if env := fakeClaudeEnv(t, Spec{Prompt: "x", AllowEnv: []string{"CINDER_TEST_LISTED"}}); !strings.Contains(env, "\nCINDER_TEST_LISTED=yes\n") {
		t.Fatalf("harness env = %q, want CINDER_TEST_LISTED=yes", env)
	}
}

func TestRun_Gateway_SendsMetadataThroughGateway(t *testing.T) {
	t.Setenv("CINDER_AI_GATEWAY", "https://gateway.ai.cloudflare.com/v1/acct/cinder")
	env := fakeClaudeEnv(t, Spec{Prompt: "x", Metadata: map[string]string{"change": "c-1"}})
	for _, want := range []string{"\nANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/acct/cinder/anthropic\n", "\nANTHROPIC_CUSTOM_HEADERS=cf-aig-metadata: {\"change\":\"c-1\"}\n"} {
		if !strings.Contains(env, want) {
			t.Fatalf("harness env = %q, want %q", env, want)
		}
	}
	if h := ProviderHost(Spec{}); h != "gateway.ai.cloudflare.com" {
		t.Fatalf("ProviderHost = %q, want the gateway host", h)
	}
}

// claude exits 1 with its reason only in the JSON result (an unreachable gateway, a refused key); the stored failure
// reason was a bare "exit status 1".
func TestRun_ClaudeExitsNonZeroWithErrorResult_ErrorCarriesTheReasonAndStderr(t *testing.T) {
	bin := t.TempDir()
	script := "#!/bin/sh\necho 'connect ECONNREFUSED' >&2\n" +
		"echo '{\"type\":\"result\",\"is_error\":true,\"result\":\"API Error: 405 only CONNECT is proxied\"}'\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := Run(context.Background(), Spec{Prompt: "fix it", Workdir: t.TempDir()})
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"exit status 1", "API Error: 405 only CONNECT is proxied", "connect ECONNREFUSED"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error = %q, want it to contain %q", err, want)
		}
	}
}

func TestRun_UnknownHarness_Fails(t *testing.T) {
	argsFile := fakeClaude(t)
	_, err := Run(context.Background(), Spec{Harness: "pi", Prompt: "p", Workdir: t.TempDir()})
	if err == nil || err.Error() != "harness pi isn't supported by this runner" {
		t.Fatalf("err = %v, want harness pi isn't supported by this runner", err)
	}
	if _, statErr := os.Stat(argsFile); statErr == nil {
		t.Fatal("claude ran for an unknown harness")
	}
}
