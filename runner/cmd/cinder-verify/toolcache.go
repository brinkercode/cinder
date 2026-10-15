package main

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/brinkercode/cinder/runner/internal/api"
)

// upstream is where a toolchain version is downloaded on a tool cache miss: the archive and the published checksum file
// (fmt templates over the version), and the directory under the unpacked tool that goes on PATH. A .tar.gz loses its
// top directory; a .zip unpacks as is.
type upstream struct{ archive, sums, bin string }

// Only these URLs are fetched, and a redirect may not leave their host: the setup egress allowlist.
var upstreams = map[string]upstream{
	"node":      {"https://nodejs.org/dist/v%[1]s/node-v%[1]s-linux-x64.tar.gz", "https://nodejs.org/dist/v%[1]s/SHASUMS256.txt", "bin"},
	"go":        {"https://dl.google.com/go/go%[1]s.linux-amd64.tar.gz", "https://dl.google.com/go/go%[1]s.linux-amd64.tar.gz.sha256", "bin"},
	"terraform": {"https://releases.hashicorp.com/terraform/%[1]s/terraform_%[1]s_linux_amd64.zip", "https://releases.hashicorp.com/terraform/%[1]s/terraform_%[1]s_SHA256SUMS", ""},
	"helm":      {"https://get.helm.sh/helm-v%[1]s-linux-amd64.tar.gz", "https://get.helm.sh/helm-v%[1]s-linux-amd64.tar.gz.sha256sum", ""},
}

var upstreamClient = &http.Client{CheckRedirect: func(r *http.Request, via []*http.Request) error {
	if len(via) >= 10 || r.URL.Host != via[0].URL.Host {
		return fmt.Errorf("setup: redirect to %s refused", r.URL.Host)
	}
	return nil
}}

// setupTool makes tool at version available and returns the directory to put first on the step's PATH, or "" when the
// image bakes that version (CINDER_BAKED lists tool=version pairs). It unpacks under $TOOL_CACHE/<tool>/<version> from the
// Worker's tool cache, or on a miss from the upstream release, checksum-verified and then uploaded for the next job.
// Notes that don't fail the step (a failed upload) go to log.
func setupTool(ctx context.Context, client *api.Client, log io.Writer, tool, version string) (string, error) {
	if slices.Contains(strings.Fields(os.Getenv("CINDER_BAKED")), tool+"="+version) {
		return "", nil
	}
	up, ok := upstreams[tool]
	if !ok {
		return "", fmt.Errorf("setup %s: cinder cannot download %s yet; use the version the worker image bakes", tool, tool)
	}
	root := os.Getenv("TOOL_CACHE")
	if root == "" {
		root = filepath.Join(os.TempDir(), "cinder-toolcache")
	}
	// Steps run as verify.JobUser: a cache it could write would hand later jobs its binaries, reused unchecked.
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	if fi, err := os.Lstat(root); err != nil || !fi.IsDir() || fi.Mode().Perm()&0o002 != 0 || fi.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
		return "", fmt.Errorf("setup %s: tool cache %s must be a directory only this runner can write", tool, root)
	}
	dest := filepath.Join(root, tool, version)
	bin := filepath.Join(dest, up.bin)
	if _, err := os.Stat(dest); err == nil {
		return bin, nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	// Unpack beside dest and rename into place, so parallel steps never see half a tool.
	tmp, err := os.MkdirTemp(filepath.Dir(dest), version+".tmp-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	if err := os.Chmod(tmp, 0o755); err != nil { // MkdirTemp's 0700 would hide the tool from verify.JobUser
		return "", err
	}
	archive, err := os.CreateTemp("", "cinder-tool-")
	if err != nil {
		return "", err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	route := client.BaseURL + "/api/work/toolcache/" + tool + "/" + version
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, route, nil)
	if err != nil {
		return "", err
	}
	resp, err := workerDo(client, req)
	if err != nil {
		return "", fmt.Errorf("setup %s %s: %w", tool, version, err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		// The cache holds the release archive as published; anyone with a runner token could have written it.
		err := install(ctx, up, version, resp.Body, archive, tmp)
		if err == nil {
			break
		}
		if !errors.Is(err, errChecksum) {
			return "", fmt.Errorf("setup %s %s: cached archive: %w", tool, version, err)
		}
		// A bad entry would break this version for every later job: replace it from upstream. The checksum is checked
		// before unpacking, so tmp is still empty.
		fmt.Fprintf(log, "setup %s %s: cached archive: %v; downloading it again\n", tool, version, err)
		if err := archive.Truncate(0); err != nil {
			return "", err
		}
		if _, err := archive.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
		fallthrough
	case http.StatusNotFound:
		body, err := fetch(ctx, fmt.Sprintf(up.archive, version))
		if err != nil {
			return "", fmt.Errorf("setup %s %s: %w", tool, version, err)
		}
		defer body.Close()
		if err := install(ctx, up, version, body, archive, tmp); err != nil {
			return "", fmt.Errorf("setup %s %s: %w", tool, version, err)
		}
		if err := upload(ctx, client, route, archive); err != nil {
			fmt.Fprintf(log, "setup %s %s: not stored in the tool cache: %v\n", tool, version, err)
		}
	default:
		return "", fmt.Errorf("setup %s %s: tool cache: status %d", tool, version, resp.StatusCode)
	}
	if err := os.Rename(tmp, dest); err != nil {
		if _, statErr := os.Stat(dest); statErr != nil { // a parallel step that put it there first is fine
			return "", err
		}
	}
	return bin, nil
}

var errChecksum = errors.New("checksum mismatch")

func workerDo(client *api.Client, req *http.Request) (*http.Response, error) {
	req.Header.Set("Authorization", "Bearer "+client.Token)
	api.SetAccess(req.Header)
	return http.DefaultClient.Do(req)
}

// install copies the release archive from body into file, checks it against the upstream published SHA-256 and unpacks
// it into dir.
func install(ctx context.Context, up upstream, version string, body io.Reader, file *os.File, dir string) error {
	archiveURL, sumsURL := fmt.Sprintf(up.archive, version), fmt.Sprintf(up.sums, version)
	sums, err := fetch(ctx, sumsURL)
	if err != nil {
		return err
	}
	defer sums.Close()
	want, name := "", path.Base(archiveURL)
	// A checksum file is either one bare hash or "<hash>  <file>" lines.
	for sc := bufio.NewScanner(sums); sc.Scan(); {
		if f := strings.Fields(sc.Text()); len(f) == 1 || len(f) >= 2 && strings.TrimPrefix(f[1], "*") == name {
			want = f[0]
			break
		}
	}
	if want == "" {
		return fmt.Errorf("%s: no checksum for %s", sumsURL, name)
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(file, h), body); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, want) {
		return fmt.Errorf("%s: %w: got %s, published %s", name, errChecksum, got, want)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if strings.HasSuffix(name, ".zip") {
		info, err := file.Stat()
		if err != nil {
			return err
		}
		return unzip(file, info.Size(), dir)
	}
	return tarExtract(file, dir, 1)
}

func fetch(ctx context.Context, u string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := upstreamClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s: status %d", u, resp.StatusCode)
	}
	return resp.Body, nil
}

// upload PUTs the release archive to the Worker's tool cache route.
func upload(ctx context.Context, client *api.Client, route string, file *os.File) error {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, route, file)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size() // the Worker refuses an archive without its length
	resp, err := workerDo(client, req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

// tarExtract unpacks a .tar.gz from r into dir, dropping strip leading path components. GNU tar refuses members that
// would land outside dir.
func tarExtract(r io.Reader, dir string, strip int) error {
	cmd := exec.Command("tar", "-xzf", "-", "-C", dir, fmt.Sprintf("--strip-components=%d", strip))
	cmd.Stdin = r
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar: %v: %s", err, out)
	}
	return nil
}

// unzip unpacks a zip into dir; os.Root refuses entries that would land outside it.
func unzip(r io.ReaderAt, size int64, dir string) error {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if err := root.MkdirAll(path.Dir(f.Name), 0o755); err != nil {
			return err
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		dst, err := root.OpenFile(f.Name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode().Perm())
		if err == nil {
			_, err = io.Copy(dst, src)
			err = errors.Join(err, dst.Close())
		}
		src.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
