package verify

import (
	"encoding/json"
	"testing"
)

func TestIngest_SecuritySeverity91_CreatesCriticalFinding(t *testing.T) {
	sarif := `{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"x","rules":[{"id":"sqli","properties":{"security-severity":"9.1"}}]}},
"results":[{"ruleId":"sqli","message":{"text":"tainted query"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"db.go"},"region":{"startLine":7}}}]}]}]}`
	payload, _ := json.Marshal(map[string]string{"sha": "abc", "target": "main", "sarif": sarif})
	rep := Ingest(payload)
	if rep.Status != "done" || len(rep.Findings) != 1 {
		t.Fatalf("want one finding, got %+v", rep)
	}
	if f := rep.Findings[0]; f.Severity != "critical" || f.Rule != "sqli" || f.File != "db.go" || f.Fingerprint == "" {
		t.Fatalf("want a critical sqli finding on db.go with a fingerprint, got %+v", f)
	}
}
