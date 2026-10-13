package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/gitauth"
)

// lock is an agent version's resolved configuration; its fields follow AgentVersion in worker/src/api/contract.js.
type lock struct {
	Name       string             `json:"name"`
	Version    int                `json:"version"`
	Harness    string             `json:"harness"`
	Model      string             `json:"model"`
	Effort     string             `json:"effort"`
	PromptHash string             `json:"prompt_hash"`
	Prompt     string             `json:"prompt"` // served to the harness as its system prompt
	Tools      []string           `json:"tools"`
	Limits     map[string]float64 `json:"limits"`
	Egress     []string           `json:"egress"`
	EgressMode string             `json:"egress_mode"` // enforce (default) or audit
	Web        string             `json:"web"`         // markdown (default) or raw
}

// draft is an agent's edited configuration as the editor saved it (PUT /api/agents/:name/draft).
type draft struct {
	Harness string             `json:"harness"`
	Model   string             `json:"model"`
	Effort  string             `json:"effort"`
	Tools   []string           `json:"tools"`
	Egress  []string           `json:"egress"`
	Web     string             `json:"web"`
	Limits  map[string]float64 `json:"limits"`
	Prompt  string             `json:"prompt"`
}

// release clones the agents repo, resolves agents/<name> into a lock, and pushes it as the
// message of the annotated tag agent/<name>/vN, N being one more than the highest existing release.
// A non-nil d is first written to agents/<name> and committed with the lock as its message, pushed with the tag.
func release(ctx context.Context, token, repo, name string, d *draft) (lock, error) {
	dir, err := os.MkdirTemp("", "cinder-release-")
	if err != nil {
		return lock{}, err
	}
	defer os.RemoveAll(dir)
	git := func(args ...string) (string, error) {
		out, err := gitauth.Command(ctx, token, append([]string{"-C", dir}, args...)...).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %w: %s", args[0], err, out)
		}
		return strings.TrimSpace(string(out)), nil
	}
	if _, err := git("clone", "--quiet", repo, "."); err != nil {
		return lock{}, err
	}
	if d != nil {
		if err := writeDraft(filepath.Join(dir, "agents", name), *d); err != nil {
			return lock{}, err
		}
	}
	l, err := resolve(filepath.Join(dir, "agents", name), name)
	if err != nil {
		return lock{}, err
	}
	prefix := "agent/" + name + "/v"
	tags, err := git("tag", "--list", prefix+"*")
	if err != nil {
		return lock{}, err
	}
	for _, t := range strings.Fields(tags) {
		if n, err := strconv.Atoi(strings.TrimPrefix(t, prefix)); err == nil && n > l.Version {
			l.Version = n
		}
	}
	l.Version++
	msg, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return lock{}, err
	}
	tag := prefix + strconv.Itoa(l.Version)
	who := []string{"-c", "user.name=cinder-agent", "-c", "user.email=cinder-agent@cinder.invalid"}
	refs := []string{"refs/tags/" + tag}
	if d != nil {
		if _, err := git("add", "--all"); err != nil {
			return lock{}, err
		}
		// --allow-empty: a draft equal to the last release still gets its own version.
		if _, err := git(append(who, "commit", "--quiet", "--allow-empty", "--cleanup=verbatim", "-m", string(msg))...); err != nil {
			return lock{}, err
		}
		refs = append(refs, "HEAD")
	}
	if _, err := git(append(who, "tag", "--annotate", "--cleanup=verbatim", "-m", string(msg), tag)...); err != nil {
		return lock{}, err
	}
	// A concurrent release of the same version is rejected here: push never overwrites an existing tag, and --atomic
	// keeps the draft commit from landing without its tag.
	if _, err := git(append([]string{"push", "--quiet", "--atomic", "origin"}, refs...)...); err != nil {
		return lock{}, err
	}
	return l, nil
}

// resolve reads agent.yml and prompt.md from dir. lazy: agent.yml is parsed as flat `key: value`
// lines with flow-style tools, egress and limits, the only form the seed uses; use a YAML parser if nesting is needed.
func resolve(dir, name string) (lock, error) {
	prompt, err := os.ReadFile(filepath.Join(dir, "prompt.md"))
	if err != nil {
		return lock{}, err
	}
	yml, err := os.ReadFile(filepath.Join(dir, "agent.yml"))
	if err != nil {
		return lock{}, err
	}
	sum := sha256.Sum256(prompt)
	l := lock{Name: name, PromptHash: "sha256:" + hex.EncodeToString(sum[:]), Prompt: string(prompt), Tools: []string{}, Limits: map[string]float64{}, Egress: []string{}, EgressMode: "enforce", Web: "markdown"}
	for _, line := range strings.Split(string(yml), "\n") {
		key, val, _ := strings.Cut(line, ":")
		val = strings.TrimSpace(val)
		switch strings.TrimSpace(key) {
		case "harness":
			l.Harness = val
		case "model":
			l.Model = val
		case "effort":
			l.Effort = val
		case "egress_mode":
			if val != "enforce" && val != "audit" {
				return lock{}, fmt.Errorf("%s/agent.yml: egress_mode %q, want enforce or audit", dir, val)
			}
			l.EgressMode = val
		case "web":
			if val != "markdown" && val != "raw" {
				return lock{}, fmt.Errorf("%s/agent.yml: web %q, want markdown or raw", dir, val)
			}
			l.Web = val
		case "tools", "egress":
			// Never nil: the Worker refuses a lock whose tools is null rather than a list.
			list := []string{}
			for _, t := range strings.Split(strings.Trim(val, "[]"), ",") {
				if t = strings.TrimSpace(t); t != "" {
					list = append(list, t)
				}
			}
			if strings.TrimSpace(key) == "tools" {
				l.Tools = list
			} else {
				l.Egress = list
			}
		case "limits":
			for _, kv := range strings.Split(strings.Trim(val, "{} "), ",") {
				k, v, _ := strings.Cut(kv, ":")
				n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				if err != nil {
					return lock{}, fmt.Errorf("agent.yml limits %q: %w", kv, err)
				}
				l.Limits[strings.TrimSpace(k)] = n
			}
		}
	}
	if l.Harness == "" || l.Model == "" || l.Effort == "" {
		return lock{}, fmt.Errorf("%s/agent.yml: harness, model and effort are required", dir)
	}
	return l, nil
}

// writeDraft replaces the draft's keys in dir/agent.yml, keeping any others (role), and writes prompt.md.
func writeDraft(dir string, d draft) error {
	var limits []string
	for _, k := range slices.Sorted(maps.Keys(d.Limits)) {
		limits = append(limits, k+": "+strconv.FormatFloat(d.Limits[k], 'g', -1, 64))
	}
	set := []string{"harness: " + d.Harness, "model: " + d.Model, "effort: " + d.Effort, "tools: [" + strings.Join(d.Tools, ", ") + "]",
		"egress: [" + strings.Join(d.Egress, ", ") + "]", "limits: { " + strings.Join(limits, ", ") + " }"}
	if d.Web != "" {
		set = append(set, "web: "+d.Web)
	}
	// A new agent has no agent.yml yet.
	old, err := os.ReadFile(filepath.Join(dir, "agent.yml"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var keep []string
	for _, line := range strings.Split(string(old), "\n") {
		key, _, _ := strings.Cut(line, ":")
		if strings.TrimSpace(line) != "" && !slices.ContainsFunc(set, func(s string) bool { return strings.HasPrefix(s, strings.TrimSpace(key)+":") }) {
			keep = append(keep, line)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "agent.yml"), []byte(strings.Join(append(keep, set...), "\n")+"\n"), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "prompt.md"), []byte(d.Prompt), 0o644)
}
