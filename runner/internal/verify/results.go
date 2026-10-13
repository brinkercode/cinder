package verify

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/testreport"
)

// parseResults reads a JUnit XML, vitest JSON or `go test -json` result file into
// per-test results. Statuses are "pass", "fail" or "skip"; durations are seconds.
func parseResults(b []byte) ([]api.TestResult, error) {
	b = bytes.TrimSpace(b)
	if bytes.HasPrefix(b, []byte("<")) {
		var r testreport.Report
		if err := r.AddJUnit(b); err != nil {
			return nil, err
		}
		if r.Dropped > 0 {
			// verify sets Tests even on error, so the kept cases still go out and Detail names the drop.
			return r.Tests, fmt.Errorf("%d test cases over the %d cap dropped", r.Dropped, testreport.MaxCases)
		}
		return r.Tests, nil
	}
	var vt struct {
		TestResults []struct {
			Name             string `json:"name"`
			AssertionResults []struct {
				FullName string  `json:"fullName"`
				Status   string  `json:"status"`
				Duration float64 `json:"duration"` // ms
			} `json:"assertionResults"`
		} `json:"testResults"`
	}
	if json.Unmarshal(b, &vt) == nil && vt.TestResults != nil {
		var out []api.TestResult
		for _, f := range vt.TestResults {
			for _, a := range f.AssertionResults {
				st := map[string]string{"passed": "pass", "failed": "fail"}[a.Status]
				out = append(out, api.TestResult{Test: f.Name + " > " + a.FullName, Status: cmp.Or(st, "skip"), Duration: a.Duration / 1000})
			}
		}
		return out, nil
	}
	return parseGoJSON(b)
}

func parseGoJSON(b []byte) ([]api.TestResult, error) {
	var out []api.TestResult
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var ev struct {
			Action, Package, Test string
			Elapsed               float64
		}
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			return nil, err
		}
		if ev.Test != "" && (ev.Action == "pass" || ev.Action == "fail" || ev.Action == "skip") {
			out = append(out, api.TestResult{Test: ev.Package + "." + ev.Test, Status: ev.Action, Duration: ev.Elapsed})
		}
	}
	return out, sc.Err()
}
