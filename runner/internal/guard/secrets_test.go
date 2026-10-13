package guard

import (
	"fmt"
	"strings"
	"testing"
)

const (
	awsKey       = "AKIAIOSFODNN7EXAMPLE"
	anthropicKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"
)

func TestScan_AWSKey_Detected(t *testing.T) {
	got := Scan("config.env", "x=1\nAWS_ACCESS_KEY_ID="+awsKey+"\n")
	if len(got) != 1 || got[0].Rule != "aws_access_key_id" || got[0].Line != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestScan_AnthropicKey_Detected(t *testing.T) {
	got := Scan("a.go", `key := "`+anthropicKey+`"`)
	if len(got) != 1 || got[0].Rule != "anthropic_api_key" {
		t.Fatalf("got %+v", got)
	}
	if want := "sk-a" + strings.Repeat("*", 24) + "EFGH"; got[0].Masked != want {
		t.Fatalf("masked = %q", got[0].Masked)
	}
}

func TestFinding_NeverContainsRawSecret(t *testing.T) {
	for _, secret := range []string{awsKey, anthropicKey} {
		got := Scan("f", secret)
		if len(got) == 0 {
			t.Fatalf("%s not detected", secret)
		}
		for _, f := range got {
			if s := fmt.Sprintf("%+v", f); strings.Contains(s, secret) {
				t.Fatalf("finding leaks secret: %s", s)
			}
		}
	}
}

func TestFingerprint_StableWhenLineMoves(t *testing.T) {
	a := Scan("f", awsKey)
	b := Scan("f", "\n\n\n"+awsKey)
	if len(a) != 1 || len(b) != 1 || a[0].Line == b[0].Line {
		t.Fatalf("a=%+v b=%+v", a, b)
	}
	if a[0].Fingerprint != b[0].Fingerprint {
		t.Fatalf("fingerprint changed when line moved: %s vs %s", a[0].Fingerprint, b[0].Fingerprint)
	}
	if Scan("g", awsKey)[0].Fingerprint == a[0].Fingerprint {
		t.Fatal("fingerprint ignores path")
	}
}

func TestLooksBinary_NULByte(t *testing.T) {
	if !LooksBinary("abc\x00def") {
		t.Fatal("NUL not detected")
	}
	if LooksBinary("plain text") || LooksBinary("") {
		t.Fatal("text reported as binary")
	}
	if LooksBinary(strings.Repeat("a", 8192) + "\x00") {
		t.Fatal("NUL past 8KB should be ignored")
	}
}
