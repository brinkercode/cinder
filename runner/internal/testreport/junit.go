// Package testreport parses test result files into per-test results.
package testreport

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
)

const (
	MaxFileBytes = 20 << 20 // per result file
	MaxCases     = 10000    // across every file added to one Report
)

// Report collects results from one or more files; cases past MaxCases are counted in Dropped.
type Report struct {
	Tests   []api.TestResult
	Dropped int
}

// AddJUnit takes every <testcase> at any depth, so <testsuites>, a bare <testsuite>
// and nested suites all flatten. <failure> and <error> both count as "fail".
func (r *Report) AddJUnit(b []byte) error {
	if len(b) > MaxFileBytes {
		return fmt.Errorf("junit file is %d bytes, over the %d cap", len(b), MaxFileBytes)
	}
	d := xml.NewDecoder(bytes.NewReader(b))
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "testcase" {
			continue
		}
		if len(r.Tests) >= MaxCases {
			r.Dropped++
			continue
		}
		var tc struct {
			Class   string    `xml:"classname,attr"`
			Name    string    `xml:"name,attr"`
			Time    string    `xml:"time,attr"`
			Failure *struct{} `xml:"failure"`
			Error   *struct{} `xml:"error"`
			Skipped *struct{} `xml:"skipped"`
		}
		if err := d.DecodeElement(&tc, &se); err != nil {
			return err
		}
		st := "pass"
		switch {
		case tc.Failure != nil || tc.Error != nil:
			st = "fail"
		case tc.Skipped != nil:
			st = "skip"
		}
		secs, _ := strconv.ParseFloat(tc.Time, 64) // time is optional; missing means 0
		r.Tests = append(r.Tests, api.TestResult{Test: strings.TrimPrefix(tc.Class+"."+tc.Name, "."), Status: st, Duration: secs})
	}
}
