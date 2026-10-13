package testreport

import (
	"reflect"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
)

func TestJUnit_NestedSuites_Flattened(t *testing.T) {
	var r Report
	err := r.AddJUnit([]byte(`<testsuites><testsuite name="outer">
<testcase classname="o" name="A" time="1.5"/>
<testsuite name="inner"><testcase classname="i" name="B"><skipped/></testcase>
<testsuite name="deep"><testcase classname="d" name="C"><failure>x</failure></testcase></testsuite></testsuite>
</testsuite></testsuites>`))
	want := []api.TestResult{{Test: "o.A", Status: "pass", Duration: 1.5}, {Test: "i.B", Status: "skip"}, {Test: "d.C", Status: "fail"}}
	if err != nil || !reflect.DeepEqual(r.Tests, want) {
		t.Fatalf("got %+v, %v; want %+v", r.Tests, err, want)
	}
}

func TestJUnit_ErrorCountsAsFailure(t *testing.T) {
	var r Report
	err := r.AddJUnit([]byte(`<testsuite name="s"><testcase classname="s" name="E" time="0.25"><error message="panic"/></testcase></testsuite>`))
	want := []api.TestResult{{Test: "s.E", Status: "fail", Duration: 0.25}}
	if err != nil || !reflect.DeepEqual(r.Tests, want) {
		t.Fatalf("got %+v, %v; want %+v", r.Tests, err, want)
	}
}

func TestJUnit_CapSetsDropped(t *testing.T) {
	var r Report
	half := []byte("<testsuite>" + strings.Repeat(`<testcase name="t"/>`, MaxCases/2+3) + "</testsuite>")
	for range 2 { // the case cap is cumulative across files
		if err := r.AddJUnit(half); err != nil {
			t.Fatal(err)
		}
	}
	if len(r.Tests) != MaxCases || r.Dropped != 6 {
		t.Fatalf("tests = %d, dropped = %d; want %d, 6", len(r.Tests), r.Dropped, MaxCases)
	}
	if err := r.AddJUnit(make([]byte, MaxFileBytes+1)); err == nil {
		t.Fatal("file over the byte cap was parsed")
	}
}
