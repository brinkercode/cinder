package edits

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/symbols"
)

func TestHook_ErrorBlocksEdit_WarningsInjectedAsContext(t *testing.T) {
	dir := t.TempDir()
	src := "package a\n\nfunc F() {}\n\nfunc G() {\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "--quiet"}, {"add", "-A"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	base, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	// The Worker answers an error for a write to F (its signature changed on the target), a warning for G.
	g := &Gate{Dir: dir, Base: strings.TrimSpace(string(base)), Check: func(_ context.Context, _ string, writes []symbols.Write, _ []string) ([]Diagnostic, error) {
		var out []Diagnostic
		for _, w := range writes {
			switch w.Symbol {
			case "a.go#F":
				out = append(out, Diagnostic{Severity: "error", File: "a.go", Symbol: w.Symbol, Change: "c1", Intent: "rename F", Suggestion: "rebase onto main"})
			case "a.go#G":
				out = append(out, Diagnostic{Severity: "warning", File: "a.go", Symbol: w.Symbol, Change: "c2", Intent: "tune G", Suggestion: "stack on c2"})
			}
		}
		return out, nil
	}}
	hook := func(event map[string]any) map[string]any {
		in, _ := json.Marshal(event)
		out, err := g.Hook(context.Background(), in)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(out, &m); err != nil {
			t.Fatalf("hook output %s: %v", out, err)
		}
		return m
	}
	edit := func(event, old, new string) map[string]any {
		return hook(map[string]any{"hook_event_name": event, "tool_name": "Edit",
			"tool_input": map[string]any{"file_path": filepath.Join(dir, "a.go"), "old_string": old, "new_string": new}})
	}

	denied := edit("PreToolUse", "func F() {}", "func F(x int) {}")["hookSpecificOutput"].(map[string]any)
	if denied["permissionDecision"] != "deny" || !strings.Contains(denied["permissionDecisionReason"].(string), "a.go#F") {
		t.Fatalf("pre-edit of F = %v, want deny naming a.go#F", denied)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.go")); string(b) != src {
		t.Fatalf("a.go = %q after the pre-edit check, want it untouched", b)
	}
	if allowed := edit("PreToolUse", "func G() {\n}", "func G() {\n\tF()\n}"); len(allowed) != 0 {
		t.Fatalf("pre-edit of G = %v, want no decision (a warning doesn't block)", allowed)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte(strings.Replace(src, "func G() {\n}", "func G() {\n\tF()\n}", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := edit("PostToolUse", "func G() {\n}", "func G() {\n\tF()\n}")["hookSpecificOutput"].(map[string]any)
	if s, _ := ctx["additionalContext"].(string); !strings.Contains(s, "warning: a.go#G") || !strings.Contains(s, "stack on c2") || !strings.Contains(s, "tune G") {
		t.Fatalf("post-edit context = %v, want the warning on a.go#G with its change, intent and suggestion", ctx)
	}
}
