package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRepoCredentials_ThroughAccess_PrintsToken(t *testing.T) {
	t.Setenv("CINDER_ACCESS_CLIENT_ID", "svc.access")
	t.Setenv("CINDER_ACCESS_CLIENT_SECRET", "s3cret")
	// The edge admits only the service token; the Worker then answers for the token's identity.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("CF-Access-Client-Id") != "svc.access" || r.Header.Get("CF-Access-Client-Secret") != "s3cret" ||
			r.Method != http.MethodPost || r.URL.Path != "/api/repos/pulse/git-credentials" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Write([]byte(`{"remote":"https://artifacts.fake/cinder/pulse.git","token":"push-token","expires_at":"2026-10-09T00:10:00Z"}`))
	}))
	defer srv.Close()
	var out bytes.Buffer
	if err := run([]string{"repo", "credentials", "pulse"}, srv.URL, "", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"token":"push-token"`) {
		t.Fatalf("output %q", out.String())
	}
}
