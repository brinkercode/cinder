package mask

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

const secret = "ghs_s3cr3t/token+value"

func masked(t *testing.T, chunks ...string) string {
	var out bytes.Buffer
	m := New(&out)
	if err := m.Add(secret); err != nil {
		t.Fatal(err)
	}
	for _, c := range chunks {
		if _, err := m.Write([]byte(c)); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func TestMask_SplitAcrossWrites(t *testing.T) {
	got := masked(t, "token=ghs_s3c", "r3t/tok", "en+value\nnext line\n")
	if got != "token=***\nnext line\n" {
		t.Fatalf("got %q", got)
	}
}

func TestMask_Base64Form(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString([]byte(secret))
	got := masked(t, "auth "+b64[:5], b64[5:]+" done")
	if strings.Contains(got, b64[:len(b64)-2]) || !strings.HasPrefix(got, "auth ***") || !strings.HasSuffix(got, " done") {
		t.Fatalf("got %q", got)
	}
	if got := masked(t, "q=ghs_s3cr3t%2Ftoken%2Bvalue"); got != "q=***" {
		t.Fatalf("url-encoded form: got %q", got)
	}
}

func TestMask_ShortValueRejected(t *testing.T) {
	m := New(&bytes.Buffer{})
	if err := m.Add("1234567"); err == nil {
		t.Fatal("7-character value was accepted")
	}
	if err := m.Add("12345678"); err != nil {
		t.Fatalf("8-character value refused: %v", err)
	}
}
