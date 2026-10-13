package main

import (
	"slices"
	"testing"
	"time"
)

// A flow with no jobs runs its steps in one legacy job; a step that ends before its first 500 ms flush, masked or not,
// still sends every line, in order and once, and its annotations before the step's status is reported.
func TestStepLog_ShortStepFlushesEveryLineBeforeReport(t *testing.T) {
	steps := []map[string]any{{"name": "ok", "run": "echo a; echo b; printf c", "needs": []string{}},
		{"name": "masked", "run": `echo "key $SECRET_KEY"; echo '##[warning]careful'`, "secrets": []string{"SECRET_KEY"}, "needs": []string{"ok"}}}
	report, calls := runRunJob(t, steps, fakeRun{legacy: true, secrets: map[string]string{"SECRET_KEY": "s3cr3t-value"}})
	if report.Status != "done" {
		t.Fatalf("report %+v, want done", report)
	}
	for idx, want := range [][]string{{"a", "b", "c"}, {"key ***", "##[warning]careful"}} {
		if got := texts(calls, idx); !slices.Equal(got, want) {
			t.Errorf("step %d log = %q, want %q", idx, got, want)
		}
	}
	var kinds []string
	for _, c := range calls {
		kinds = append(kinds, c.Kind+" "+c.Status)
	}
	// Set up job and Checkout come first and Complete job last, each a status, its lines and a status.
	sys := []string{"status running", "log ", "status passed"}
	if want := slices.Concat(sys, sys, []string{"step running", "log ", "step passed", "step running", "log ", "annotations ", "step passed"}, sys); !slices.Equal(slices.Compact(kinds), want) {
		t.Errorf("posts %q, want the runner's own steps around each step's lines and annotations before its status: %q", kinds, want)
	}
}

// A step whose output outlasts it in the pipe while slow log posts drain it still sends every line: draining is not cut
// short by the 10 s wait for output after the step exits.
func TestStepLog_TwentyThousandLines_AllReachTheLog(t *testing.T) {
	steps := []map[string]any{{"name": "long", "run": "seq 1 20000", "needs": []string{}}}
	report, calls := runRunJob(t, steps, fakeRun{legacy: true, logDelay: 150 * time.Millisecond})
	got := texts(calls, 0)
	if report.Status != "done" || len(got) != 20000 || got[0] != "1" || got[19999] != "20000" {
		t.Fatalf("report %+v, %d lines (last %q); want done with all 20000", report, len(got), got[len(got)-1:])
	}
}
