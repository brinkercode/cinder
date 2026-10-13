package verify

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
)

// findings reads every *.sarif under dir and keeps the results on lines the change
// (merge-base of branch to HEAD) added or modified, or every result when branch is "".
func findings(ctx context.Context, dir, branch string) ([]api.Finding, error) {
	var changed map[string]map[int]bool
	if branch != "" {
		var err error
		if changed, err = changedLines(ctx, dir, branch); err != nil {
			return nil, err
		}
	}
	var out []api.Finding
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if !d.Type().IsRegular() || filepath.Ext(p) != ".sarif" {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		all, err := parseSARIF(b, dir)
		if err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
		for _, f := range all {
			if changed == nil || changed[f.File][f.Line] {
				out = append(out, api.Finding{Rule: f.Rule, File: f.File, Line: f.Line})
			}
		}
		return nil
	})
	return out, err
}

// Ingest runs an ingest-sarif job: every result in the uploaded log (payload {sarif}) becomes a finding with a
// severity and a line-free fingerprint, which the Worker stores as source code.
func Ingest(payload []byte) api.Report {
	var p struct {
		SARIF string `json:"sarif"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return api.Report{Status: "failed", Detail: "ingest-sarif payload: " + err.Error()}
	}
	all, err := parseSARIF([]byte(p.SARIF), "")
	if err != nil {
		return api.Report{Status: "failed", Detail: "ingest-sarif: " + err.Error()}
	}
	out := make([]api.Finding, len(all))
	for i, f := range all {
		if f.Rule == "" {
			f.Rule = "unknown" // ruleId is optional in SARIF; the Worker needs a rule
		}
		sum := sha256.Sum256([]byte(f.Rule + "\x00" + f.File + "\x00" + f.message))
		f.Fingerprint = "sha256:" + hex.EncodeToString(sum[:])
		out[i] = f.Finding
	}
	return api.Report{Status: "done", Findings: out}
}

type result struct {
	api.Finding
	message string
}

// parseSARIF returns one finding per result location, its severity from the rule's security-severity score (or the
// result's level when the rule has none). URIs under dir are made relative to it.
func parseSARIF(b []byte, dir string) ([]result, error) {
	var log struct {
		Runs []struct {
			Tool struct {
				Driver struct {
					Rules []struct {
						ID         string `json:"id"`
						Properties struct {
							SecuritySeverity json.RawMessage `json:"security-severity"`
						} `json:"properties"`
					} `json:"rules"`
				} `json:"driver"`
			} `json:"tool"`
			Results []struct {
				RuleID  string `json:"ruleId"`
				Level   string `json:"level"`
				Message struct {
					Text string `json:"text"`
				} `json:"message"`
				Locations []struct {
					PhysicalLocation struct {
						ArtifactLocation struct {
							URI string `json:"uri"`
						} `json:"artifactLocation"`
						Region struct {
							StartLine int `json:"startLine"`
						} `json:"region"`
					} `json:"physicalLocation"`
				} `json:"locations"`
			} `json:"results"`
		} `json:"runs"`
	}
	if err := json.Unmarshal(b, &log); err != nil {
		return nil, err
	}
	var out []result
	for _, run := range log.Runs {
		scores := map[string]string{}
		for _, r := range run.Tool.Driver.Rules {
			scores[r.ID] = strings.Trim(string(r.Properties.SecuritySeverity), `"`)
		}
		for _, r := range run.Results {
			for _, l := range r.Locations {
				file := strings.TrimPrefix(l.PhysicalLocation.ArtifactLocation.URI, "file://")
				if rel, err := filepath.Rel(dir, file); filepath.IsAbs(file) && err == nil {
					file = rel
				}
				out = append(out, result{api.Finding{Rule: r.RuleID, File: path.Clean(filepath.ToSlash(file)),
					Line: l.PhysicalLocation.Region.StartLine, Severity: severity(scores[r.RuleID], r.Level)}, r.Message.Text})
			}
		}
	}
	return out, nil
}

// severity maps a CVSS-style security-severity score to critical (>= 9), high (>= 7), medium (>= 4) or low, the
// bands GitHub code scanning uses. Without a score, a SARIF level of error is high, note or none is low, else medium.
func severity(score, level string) string {
	if s, err := strconv.ParseFloat(score, 64); err == nil {
		switch {
		case s >= 9:
			return "critical"
		case s >= 7:
			return "high"
		case s >= 4:
			return "medium"
		}
		return "low"
	}
	switch level {
	case "error":
		return "high"
	case "note", "none":
		return "low"
	}
	return "medium"
}

// changedLines maps each file to the new-side line numbers the change added or modified.
func changedLines(ctx context.Context, dir, branch string) (map[string]map[int]bool, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "diff", "-U0", "--no-ext-diff", "--no-textconv", "--no-renames",
		"--no-prefix", "refs/heads/"+branch+"...HEAD", "--").Output()
	if err != nil {
		return nil, fmt.Errorf("git diff: %w", err)
	}
	changed := map[string]map[int]bool{}
	var file string
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		t := sc.Text()
		if f, ok := strings.CutPrefix(t, "+++ "); ok {
			// lazy: git quotes paths with special characters; those files never match a finding.
			file = f
			changed[file] = map[int]bool{}
			continue
		}
		hunk, ok := strings.CutPrefix(t, "@@ ")
		if !ok {
			continue
		}
		// @@ -a,b +start,count @@; count defaults to 1 and is 0 for a pure deletion.
		fields := strings.Fields(hunk)
		if len(fields) < 2 {
			continue
		}
		start, count, hasCount := strings.Cut(strings.TrimPrefix(fields[1], "+"), ",")
		c := 1
		n, err := strconv.Atoi(start)
		if err == nil && hasCount {
			c, err = strconv.Atoi(count)
		}
		if err != nil {
			return nil, fmt.Errorf("git diff hunk %q: %w", t, err)
		}
		for i := n; i < n+c; i++ {
			changed[file][i] = true
		}
	}
	return changed, sc.Err()
}
