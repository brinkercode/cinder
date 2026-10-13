package verify

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
)

func TestRun_EachResultFormat_ParsesASample(t *testing.T) {
	want := []api.TestResult{{Test: "a.TestOK", Status: "pass", Duration: 0.5}, {Test: "a.TestBad", Status: "fail"}, {Test: "a.TestSkip", Status: "skip"}}
	samples := map[string]string{
		"go test -json": `{"Action":"run","Package":"a","Test":"TestOK"}
{"Action":"output","Package":"a","Test":"TestOK","Output":"ok\n"}
{"Action":"pass","Package":"a","Test":"TestOK","Elapsed":0.5}
{"Action":"fail","Package":"a","Test":"TestBad","Elapsed":0}
{"Action":"skip","Package":"a","Test":"TestSkip","Elapsed":0}
{"Action":"fail","Package":"a","Elapsed":0.6}
`,
		"vitest json": `{"numTotalTests":3,"testResults":[{"name":"a","assertionResults":[
{"fullName":"TestOK","status":"passed","duration":500},
{"fullName":"TestBad","status":"failed","duration":0},
{"fullName":"TestSkip","status":"pending","duration":null}]}]}`,
		"junit xml": `<?xml version="1.0"?>
<testsuites><testsuite name="a">
<testcase classname="a" name="TestOK" time="0.5"/>
<testcase classname="a" name="TestBad" time="0"><failure message="boom">trace</failure></testcase>
<testcase classname="a" name="TestSkip"><skipped/></testcase>
</testsuite></testsuites>`,
	}
	for name, body := range samples {
		t.Run(name, func(t *testing.T) {
			j := repos(t)
			j.Check, j.Results = "true", "out/results"
			j.Acceptance = map[string]string{"out/results": body}
			// vitest names tests "<file> > <fullName>"
			w := want
			if name == "vitest json" {
				w = []api.TestResult{{Test: "a > TestOK", Status: "pass", Duration: 0.5}, {Test: "a > TestBad", Status: "fail"}, {Test: "a > TestSkip", Status: "skip"}}
			}
			rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
			if !reflect.DeepEqual(rep.Tests, w) {
				t.Fatalf("tests = %+v, want %+v (detail %q)", rep.Tests, w, rep.Detail)
			}
		})
	}
}
