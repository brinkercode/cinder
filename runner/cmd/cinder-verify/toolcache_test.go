package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
)

// stubGo serves a go release (go/bin/go printing its version) and its .sha256 file, the published hash being sum when
// set; it replaces the go upstream for the test and counts every request.
func stubGo(t *testing.T, sum string) *int {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	script := "#!/bin/sh\necho go1.24.13\n"
	_ = tw.WriteHeader(&tar.Header{Name: "go/bin/go", Mode: 0o755, Size: int64(len(script))})
	_, _ = tw.Write([]byte(script))
	_ = tw.Close()
	_ = gz.Close()
	if sum == "" {
		h := sha256.Sum256(buf.Bytes())
		sum = hex.EncodeToString(h[:])
	}
	hits := new(int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			_, _ = w.Write([]byte(sum + "\n"))
			return
		}
		_, _ = w.Write(buf.Bytes())
	}))
	t.Cleanup(srv.Close)
	old := upstreams["go"]
	upstreams["go"] = upstream{srv.URL + "/go%[1]s.linux-amd64.tar.gz", srv.URL + "/go%[1]s.linux-amd64.tar.gz.sha256", "bin"}
	t.Cleanup(func() { upstreams["go"] = old })
	t.Setenv("CINDER_BAKED", "")
	return hits
}

// fakeToolCache is the Worker's toolcache route: 404 until a PUT stores the object. It counts every request.
type fakeToolCache struct {
	mu        sync.Mutex
	objects   map[string][]byte
	puts, all int
}

func (f *fakeToolCache) client(t *testing.T) *api.Client {
	f.objects = map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.all++
		if r.Header.Get("Authorization") != "Bearer runner-token" || !strings.HasPrefix(r.URL.Path, "/api/work/toolcache/") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		switch body, ok := f.objects[r.URL.Path]; r.Method {
		case http.MethodPut:
			f.puts++
			f.objects[r.URL.Path], _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(body)
		}
	}))
	t.Cleanup(srv.Close)
	return &api.Client{BaseURL: srv.URL, Token: "runner-token"}
}

func TestSetupTool_CacheMiss_DownloadsVerifiesUploadsOnce_SecondResolveUsesCache(t *testing.T) {
	hits := stubGo(t, "")
	var cache fakeToolCache
	client := cache.client(t)
	for i := range 2 {
		t.Setenv("TOOL_CACHE", t.TempDir()) // each resolve on a fresh container disk
		bin, err := setupTool(context.Background(), client, io.Discard, "go", "1.24.13")
		if err != nil {
			t.Fatal(err)
		}
		if out, err := os.ReadFile(filepath.Join(bin, "go")); err != nil || !strings.Contains(string(out), "go1.24.13") {
			t.Fatalf("resolve %d: %s/go = %q, %v", i, bin, out, err)
		}
		if *hits != 2+i || cache.puts != 1 {
			t.Fatalf("resolve %d: upstream hits %d (want 2: checksum and archive, then 1 checksum per cache hit), uploads %d (want 1)", i, *hits, cache.puts)
		}
	}
	if _, ok := cache.objects["/api/work/toolcache/go/1.24.13"]; !ok {
		t.Fatalf("stored %v, want /api/work/toolcache/go/1.24.13", cache.objects)
	}
}

func TestSetupTool_ChecksumMismatch_FailsStepAndUploadsNothing(t *testing.T) {
	stubGo(t, strings.Repeat("0", 64))
	t.Setenv("TOOL_CACHE", t.TempDir())
	var cache fakeToolCache
	_, err := setupTool(context.Background(), cache.client(t), io.Discard, "go", "1.24.13")
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") || cache.puts != 0 {
		t.Fatalf("err %v, uploads %d; want a checksum mismatch and no upload", err, cache.puts)
	}
	if entries, _ := os.ReadDir(filepath.Join(os.Getenv("TOOL_CACHE"), "go")); len(entries) != 0 {
		t.Fatalf("left %v in the tool cache dir", entries)
	}
	report, reports := runFlowJob(t, []map[string]any{{"name": "build", "stage": "build", "run": "go version", "setup": map[string]string{"go": "1.24.13"}, "needs": []string{}}}, nil)
	last := reports[len(reports)-1]
	if report.Status != "failed" || last.Status != "failed" || !strings.Contains(last.Logs, "checksum mismatch") {
		t.Fatalf("report %+v, last step %+v; want the step failed on the checksum", report, last)
	}
}

func TestSetup_BadCachedArchive_RefetchesUpstream(t *testing.T) {
	hits := stubGo(t, "")
	t.Setenv("TOOL_CACHE", t.TempDir())
	var cache fakeToolCache
	client := cache.client(t)
	var poisoned bytes.Buffer
	gz := gzip.NewWriter(&poisoned)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "bin/go", Mode: 0o755, Size: 4})
	_, _ = tw.Write([]byte("evil"))
	_ = tw.Close()
	_ = gz.Close()
	key := "/api/work/toolcache/go/1.24.13"
	cache.objects[key] = poisoned.Bytes()
	var log bytes.Buffer
	bin, err := setupTool(context.Background(), client, &log, "go", "1.24.13")
	if err != nil {
		t.Fatal(err)
	}
	if out, err := os.ReadFile(filepath.Join(bin, "go")); err != nil || !strings.Contains(string(out), "go1.24.13") {
		t.Fatalf("%s/go = %q, %v; want the upstream release", bin, out, err)
	}
	if !strings.Contains(log.String(), "checksum mismatch") {
		t.Fatalf("log %q; want the mismatch noted", log.String())
	}
	if *hits != 3 || cache.puts != 1 || bytes.Equal(cache.objects[key], poisoned.Bytes()) {
		t.Fatalf("upstream hits %d (want 3: checksum, checksum, archive), uploads %d (want 1), cache entry replaced %v",
			*hits, cache.puts, !bytes.Equal(cache.objects[key], poisoned.Bytes()))
	}
	// The next job on a fresh disk takes the replaced entry from the cache.
	t.Setenv("TOOL_CACHE", t.TempDir())
	if _, err := setupTool(context.Background(), client, io.Discard, "go", "1.24.13"); err != nil || *hits != 4 || cache.puts != 1 {
		t.Fatalf("second resolve: err %v, upstream hits %d (want 4), uploads %d (want 1)", err, *hits, cache.puts)
	}
}

func TestSetupTool_BakedVersion_MakesNoNetworkCall(t *testing.T) {
	hits := stubGo(t, "")
	t.Setenv("CINDER_BAKED", "node=22.20.0 go=1.24.13")
	t.Setenv("TOOL_CACHE", t.TempDir())
	var cache fakeToolCache
	bin, err := setupTool(context.Background(), cache.client(t), io.Discard, "go", "1.24.13")
	if bin != "" || err != nil || *hits != 0 || cache.all != 0 {
		t.Fatalf("bin %q, err %v, upstream hits %d, tool cache calls %d; want no PATH change and no network", bin, err, *hits, cache.all)
	}
}

func TestFlow_SetupStep_RunsWithToolOnPath(t *testing.T) {
	stubGo(t, "")
	t.Setenv("TOOL_CACHE", t.TempDir())
	report, reports := runFlowJob(t, []map[string]any{{"name": "build", "stage": "build", "run": "go", "setup": map[string]string{"go": "1.24.13"}, "needs": []string{}}}, nil)
	last := reports[len(reports)-1]
	if report.Status != "done" || last.Status != "passed" || !strings.Contains(last.Logs, "go1.24.13") {
		t.Fatalf("report %+v, last step %+v; want the stub go on PATH", report, last)
	}
}

func TestSetupTool_CacheDirOthersCanWrite_Refused(t *testing.T) {
	stubGo(t, "")
	var cache fakeToolCache
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TOOL_CACHE", dir)
	if _, err := setupTool(context.Background(), cache.client(t), io.Discard, "go", "1.24.13"); err == nil || !strings.Contains(err.Error(), "only this runner can write") {
		t.Fatalf("err = %v, want a job-writable tool cache refused", err)
	}
}

func TestSetupTool_UnpackedTool_ReadableByJobUserNotWritable(t *testing.T) {
	stubGo(t, "")
	var cache fakeToolCache
	t.Setenv("TOOL_CACHE", t.TempDir())
	bin, err := setupTool(context.Background(), cache.client(t), io.Discard, "go", "1.24.13")
	if err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(filepath.Dir(bin)); err != nil || fi.Mode().Perm() != 0o755 {
		t.Fatalf("tool dir mode = %v, %v; want 0755", fi.Mode().Perm(), err)
	}
}
