package main

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/egress"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/harness"
)

// reviewAsk is the task the reviewer's version prompt gets: the intent, the diff and the answer's shape.
const reviewAsk = "Review this change against its intent. Answer with one JSON object and nothing after it:\n" +
	`{"verdict": "pass" or "fail", "summary": "one line", "findings": [{"path": "file", "line": 1, "body": "what is wrong and how to fix it"}]}` +
	"\nfail only for a defect the change must fix before it merges; each finding is on a line the diff adds.\n"

// verdict is the reviewer's answer.
type verdict struct {
	Verdict  string        `json:"verdict"`
	Summary  string        `json:"summary"`
	Findings []api.Finding `json:"findings"`
}

// reviewChange clones the fork read-only, diffs its head against base (the target the verify ran on) and asks the
// harness for a verdict. The returned report is the job's: done on pass, failed with line findings on fail.
// lazy: a base the fork lacks (the target moved past the fork) reviews the head commit alone.
func reviewChange(ctx context.Context, readToken, fork, branch, base, intent string, allow []string, spec harness.Spec, used *harness.Result) (api.Report, error) {
	dir, err := os.MkdirTemp("", "cinder-review-")
	if err != nil {
		return api.Report{}, err
	}
	defer os.RemoveAll(dir)
	git := func(args ...string) (string, error) {
		out, err := gitauth.Command(ctx, readToken, append([]string{"-C", dir}, args...)...).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %w: %s", args[0], err, out)
		}
		return string(out), nil
	}
	if _, err := git("clone", "--quiet", "--branch", branch, fork, "."); err != nil {
		return api.Report{}, err
	}
	diffArgs := []string{"show", "--format=", "HEAD"}
	if _, err := git("cat-file", "-e", base+"^{commit}"); base != "" && err == nil {
		diffArgs = []string{"diff", base + "...HEAD"}
	}
	diff, err := git(diffArgs...)
	if err != nil {
		return api.Report{}, err
	}
	spec.Prompt = fmt.Sprintf("%s\n## Intent\n%s\n\n## Diff\n%s\n\n---\n\n%s", reviewAsk, intent, diff, spec.Prompt)
	spec.Workdir = dir
	if readToken != "" {
		spec.Secrets = append(spec.Secrets, readToken)
	}
	forkURL, err := url.Parse(fork)
	if err != nil {
		return api.Report{}, err
	}
	proxy, err := egress.Start(allow, false, harness.ProviderHost(spec), forkURL.Hostname())
	if err != nil {
		return api.Report{}, err
	}
	defer proxy.Close()
	spec.Env = append(spec.Env, proxy.AgentEnv()...)
	res, err := harness.Run(ctx, spec)
	*used = res
	if err != nil {
		return api.Report{}, err
	}
	v, err := parseVerdict(res.Output)
	if err != nil {
		return api.Report{}, err
	}
	if v.Verdict == "pass" {
		return api.Report{Status: "done", Detail: v.Summary, Verdict: "pass"}, nil
	}
	return api.Report{Status: "failed", Detail: cmp.Or(v.Summary, "review failed"), Findings: v.Findings, Verdict: "fail"}, nil
}

// parseVerdict reads the last JSON object in the harness's output (a JSON string of the model's text, or the
// structured result). Findings the Worker would refuse (no path, line or body) are dropped.
func parseVerdict(out json.RawMessage) (verdict, error) {
	text := string(out)
	_ = json.Unmarshal(out, &text) // a text result is a JSON string; a structured one stays as it is
	var v verdict
	start, end := strings.LastIndex(text, `{"verdict"`), strings.LastIndex(text, "}")
	if start < 0 {
		start = strings.Index(text, "{")
	}
	if start < 0 || end < start || json.Unmarshal([]byte(text[start:end+1]), &v) != nil || (v.Verdict != "pass" && v.Verdict != "fail") {
		return verdict{}, fmt.Errorf("reviewer gave no verdict: %.200s", text)
	}
	kept := v.Findings[:0]
	for _, f := range v.Findings {
		if f.Path != "" && f.Line >= 1 && f.Body != "" {
			kept = append(kept, api.Finding{Path: f.Path, Line: f.Line, Body: f.Body})
		}
	}
	v.Findings = kept
	return v, nil
}
