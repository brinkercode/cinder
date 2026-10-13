// Package edits checks an agent's edits against the Worker's lease map while the agent runs (POST /api/work/edit-check):
// a harness hook before and after each edit, and a finish gate before the run completes.
package edits

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/brinkercode/cinder/runner/internal/symbols"
)

// Diagnostic is one finding of the edit check: Change is the other change ("" for this change's own lease).
type Diagnostic struct {
	Severity   string `json:"severity"` // "error", "warning" or "info"
	File       string `json:"file"`
	Symbol     string `json:"symbol"`
	Change     string `json:"change"`
	Intent     string `json:"intent"`
	Suggestion string `json:"suggestion"`
}

// Checker asks the Worker about the writes and reads of edits made on base.
type Checker func(ctx context.Context, base string, writes []symbols.Write, reads []string) ([]Diagnostic, error)

// Gate checks the edits in the checkout at Dir against Base, the commit the run started from.
type Gate struct {
	Dir, Base string
	Check     Checker
	mu        sync.Mutex // one check at a time: a pre-edit check puts the proposed file in place
}

// Diagnose checks the diff from Base to the working tree, limited to paths when any are given.
func (g *Gate) Diagnose(ctx context.Context, paths ...string) ([]Diagnostic, error) {
	// A throwaway index stages new files for the diff without touching the agent's own index.
	tmp, err := os.MkdirTemp("", "cinder-edits-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	var diff string
	for _, args := range [][]string{{"read-tree", g.Base}, append([]string{"add", "-A", "--"}, paths...),
		append([]string{"diff", "--cached", "-U0", "--no-renames", g.Base, "--"}, paths...)} {
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", g.Dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+filepath.Join(tmp, "index"))
		out, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("git %s: %w", args[0], err)
		}
		diff = string(out)
	}
	_, writes, reads, err := symbols.Push(g.Dir, diff)
	if err != nil {
		return nil, err
	}
	if len(writes) == 0 && len(reads) == 0 {
		return nil, nil
	}
	return g.Check(ctx, g.Base, writes, reads)
}

// Finish is the finish gate: the whole diff's diagnostics and the open errors a run may not complete with.
func (g *Gate) Finish(ctx context.Context) (all, open []Diagnostic, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	all, err = g.Diagnose(ctx)
	for _, d := range all {
		if d.Severity == "error" {
			open = append(open, d)
		}
	}
	return all, open, err
}

// edit is one string replacement of a claude-code Edit or MultiEdit.
type edit struct {
	Old        string `json:"old_string"`
	New        string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all"`
}

// hookInput is the part of a claude-code hook event the gate reads.
type hookInput struct {
	Event      string `json:"hook_event_name"` // PreToolUse, PostToolUse or Stop
	StopActive bool   `json:"stop_hook_active"`
	Tool       struct {
		Path    string  `json:"file_path"`
		Content *string `json:"content"` // Write
		edit            // Edit
		Edits   []edit  `json:"edits"` // MultiEdit
	} `json:"tool_input"`
}

// Hook answers one claude-code hook event with the hook's JSON output: before an edit (PreToolUse) an error denies it;
// after one (PostToolUse) every error and warning is added as context; on Stop an open error blocks finishing, once:
// an agent that still can't fix it stops, and cinder settles the collision from the run's report (stack or seam).
func (g *Gate) Hook(ctx context.Context, event []byte) ([]byte, error) {
	var in hookInput
	if err := json.Unmarshal(event, &in); err != nil {
		return nil, err
	}
	switch in.Event {
	case "PreToolUse":
		diags, err := g.proposed(ctx, in)
		if err != nil {
			return nil, err
		}
		if errs := Text(diags, "error"); errs != "" {
			return json.Marshal(map[string]any{"hookSpecificOutput": map[string]string{"hookEventName": in.Event,
				"permissionDecision": "deny", "permissionDecisionReason": "The edit collides with other changes:\n" + errs}})
		}
	case "PostToolUse":
		g.mu.Lock()
		diags, err := g.Diagnose(ctx, in.Tool.Path)
		g.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if s := Text(diags, "error", "warning"); s != "" {
			return json.Marshal(map[string]any{"hookSpecificOutput": map[string]string{"hookEventName": in.Event,
				"additionalContext": "Edit check:\n" + s}})
		}
	case "Stop":
		_, open, err := g.Finish(ctx)
		if err != nil {
			return nil, err
		}
		if len(open) > 0 && !in.StopActive {
			return json.Marshal(map[string]string{"decision": "block",
				"reason": "Fix these edit-check errors, or stop and report a blocker:\n" + Text(open, "error")})
		}
	}
	return []byte("{}"), nil
}

// proposed diagnoses the file an Edit, MultiEdit or Write would leave, then puts the file back.
func (g *Gate) proposed(ctx context.Context, in hookInput) ([]Diagnostic, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	path := in.Tool.Path
	rel, err := filepath.Rel(g.Dir, path)
	if path == "" || err != nil || strings.HasPrefix(rel, "..") {
		return nil, nil // outside the checkout: not part of the change
	}
	old, err := os.ReadFile(path)
	existed := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	next := string(old)
	if in.Tool.Content != nil {
		next = *in.Tool.Content
	} else {
		edits := in.Tool.Edits
		if len(edits) == 0 {
			edits = []edit{in.Tool.edit}
		}
		for _, e := range edits {
			if !strings.Contains(next, e.Old) {
				return nil, nil // the edit itself will fail
			}
			n := 1
			if e.ReplaceAll {
				n = -1
			}
			next = strings.Replace(next, e.Old, e.New, n)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(next), 0o644); err != nil {
		return nil, err
	}
	diags, err := g.Diagnose(ctx, rel)
	restore := os.WriteFile(path, old, 0o644)
	if !existed {
		restore = os.Remove(path)
	}
	return diags, errors.Join(err, restore)
}

// Text lists the diagnostics of the given severities, one per line.
func Text(diags []Diagnostic, severities ...string) string {
	var b strings.Builder
	for _, d := range diags {
		if slices.Contains(severities, d.Severity) {
			fmt.Fprintf(&b, "- %s: %s (%s): %s [change %s: %s]\n", d.Severity, d.Symbol, d.File, d.Suggestion, d.Change, d.Intent)
		}
	}
	return b.String()
}

// Serve answers hook events POSTed to the returned loopback URL (`cinder-agent edit-hook` forwards them), so the
// runner's token stays out of the harness. close stops it.
func (g *Gate) Serve(ctx context.Context) (url string, close func() error, err error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	// The random path keeps other local processes from checking edits as this job.
	path := "/" + rand.Text()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path {
			http.NotFound(w, r)
			return
		}
		out, err := io.ReadAll(r.Body)
		if err == nil {
			out, err = g.Hook(ctx, out)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_, _ = w.Write(out)
	})}
	go func() { _ = srv.Serve(ln) }() // Serve returns ErrServerClosed on close
	return "http://" + ln.Addr().String() + path, srv.Close, nil
}
