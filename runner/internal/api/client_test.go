package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJob_ChecksContractShape(t *testing.T) {
	ok := `{"id":"j1","repo_id":"r1","kind":"verify","change_id":null,"status":"queued",` +
		`"runner_id":null,"lease_expires_at":null,"created_at":"2026-10-04T10:00:00Z"}`
	_, err := DecodeJob([]byte(ok))
	_, missing := DecodeJob([]byte(strings.Replace(ok, `"runner_id":null,`, "", 1)))
	_, badKind := DecodeJob([]byte(strings.Replace(ok, `"verify"`, `"deploy"`, 1)))
	if err != nil || missing == nil || badKind == nil {
		t.Fatalf("valid: %v; missing runner_id: %v; unknown kind: %v", err, missing, badKind)
	}
}

// accessHeaders calls every client route against a fake API and returns each request's Access headers.
func accessHeaders(t *testing.T) [][2]string {
	t.Helper()
	var got [][2]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, [2]string{r.Header.Get("CF-Access-Client-Id"), r.Header.Get("CF-Access-Client-Secret")})
		if r.Header.Get("Authorization") != "Bearer runner-token" {
			t.Errorf("%s: auth %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Token: "runner-token"}
	ctx := context.Background()
	if _, err := c.Claim(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Heartbeat(ctx, "j1"); err != nil {
		t.Fatal(err)
	}
	if err := c.Report(ctx, "j1", Report{}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d requests, want 3", len(got))
	}
	return got
}

func TestClient_AccessVarsSet_EveryRequestCarriesBothHeaders(t *testing.T) {
	t.Setenv("CINDER_ACCESS_CLIENT_ID", "id.access")
	t.Setenv("CINDER_ACCESS_CLIENT_SECRET", "s3cret")
	for i, h := range accessHeaders(t) {
		if h != [2]string{"id.access", "s3cret"} {
			t.Errorf("request %d: Access headers %q", i, h)
		}
	}
}

func TestClient_AccessVarsUnset_NoAccessHeadersSent(t *testing.T) {
	t.Setenv("CINDER_ACCESS_CLIENT_ID", "")
	t.Setenv("CINDER_ACCESS_CLIENT_SECRET", "")
	for i, h := range accessHeaders(t) {
		if h != [2]string{} {
			t.Errorf("request %d: Access headers %q", i, h)
		}
	}
}

func TestClient_StepLog_PostsSeqAndLines(t *testing.T) {
	var path, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		path, body = r.Method+" "+r.URL.Path, string(b)
		if strings.Contains(body, `"seq":5`) {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":{"code":"out_of_order","message":"expected seq 3"},"expected_seq":3}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Token: "t"}
	lines := []LogLine{{At: "2026-10-08T09:00:00.1Z", Text: "##[group]build"}}
	if err := c.StepLog(context.Background(), "j1", 2, 1, lines); err != nil {
		t.Fatal(err)
	}
	if want := `{"lines":[{"at":"2026-10-08T09:00:00.1Z","text":"##[group]build"}],"seq":1}` + "\n"; path != "POST /api/work/jobs/j1/steps/2/log" || body != want {
		t.Errorf("got %s %s, want POST /api/work/jobs/j1/steps/2/log %s", path, body, want)
	}
	var conflict SeqConflict
	if err := c.StepLog(context.Background(), "j1", 2, 5, lines); !errors.As(err, &conflict) || conflict.Expected != 3 {
		t.Errorf("out-of-order batch: err %v, want SeqConflict expecting 3", err)
	}
}

func TestReport_CarriesDurationTokensAndCost(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Token: "t"}
	if err := c.Report(context.Background(), "j1", Report{Status: "done", DurationMS: 1500, Tokens: &[3]int64{120, 0, 0}, CostUSD: 0.25}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"duration_ms":1500`, `"tokens":[120,0,0]`, `"cost_usd":0.25`} {
		if !strings.Contains(body, want) {
			t.Errorf("report body %s lacks %s", body, want)
		}
	}
}
