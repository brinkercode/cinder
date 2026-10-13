// Command cinder is the owner's CLI for the cinder API. Config: CINDER_URL, CINDER_TOKEN, CINDER_REPO for env commands,
// CINDER_POOL_TOKEN for runner register without CINDER_TOKEN, and CINDER_ACCESS_CLIENT_ID/SECRET (an Access service token).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
)

const usage = `usage:
  cinder repo add <name> [--import url]
  cinder repo ls
  cinder repo airlock <name> on|off
  cinder repo credentials <name>
  cinder repo judge set <name> <kind> --backend <backend> --model <name@version> [--base-url url]
  cinder change new <repo> "<intent>" [--target branch] [--acceptance dir] [--draft]
  cinder change ready <id>
  cinder change retry <id>
  cinder change ls <repo>
  cinder change show <id>
  cinder runner register <name> --kinds develop,verify [--pool-token token]
  cinder runner revoke <id>
  cinder env ls
  cinder env sync <env>
  cinder env rollback <env> --reason "<why>"
  cinder verify-commit <sha> --key <file from GET /api/repos/:name/signing-key>`

func main() {
	if err := run(os.Args[1:], os.Getenv("CINDER_URL"), os.Getenv("CINDER_TOKEN"), os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "cinder:", err)
		os.Exit(1)
	}
}

func run(args []string, base, token string, out io.Writer) error {
	// Offline: needs only the git repo in the working directory and the saved public key, not the API.
	if len(args) >= 2 && args[0] == "verify-commit" {
		return verifyCommit(args[1], args[2:], out)
	}
	cmd := strings.Join(args[:min(2, len(args))], " ")
	// A pool token in the body is the credential for runner register, and an allowlisted Access service token
	// identifies its caller, so either alone needs no CINDER_TOKEN.
	service := os.Getenv("CINDER_ACCESS_CLIENT_ID") != "" && os.Getenv("CINDER_ACCESS_CLIENT_SECRET") != ""
	if base == "" || (token == "" && !service && cmd != "runner register") {
		return errors.New("CINDER_URL and CINDER_TOKEN (or CINDER_ACCESS_CLIENT_ID and CINDER_ACCESS_CLIENT_SECRET) must be set")
	}
	call := func(method, path string, body any) error { return send(base, token, method, path, body, out) }
	esc := url.PathEscape
	flags := flag.NewFlagSet(cmd, flag.ContinueOnError)
	switch {
	case cmd == "repo add" && len(args) >= 3:
		imp := flags.String("import", "", "git url to import")
		if err := parse(flags, args[3:]); err != nil {
			return err
		}
		body := map[string]any{"name": args[2]}
		if *imp != "" {
			body["import"] = map[string]string{"url": *imp}
		}
		return call(http.MethodPost, "/api/repos", body)
	case cmd == "repo ls" && len(args) == 2:
		return call(http.MethodGet, "/api/repos", nil)
	case cmd == "repo airlock" && len(args) == 4 && (args[3] == "on" || args[3] == "off"):
		return call(http.MethodPut, "/api/repos/"+esc(args[2])+"/airlock", map[string]any{"on": args[3] == "on"})
	case cmd == "repo credentials" && len(args) == 3:
		return call(http.MethodPost, "/api/repos/"+esc(args[2])+"/git-credentials", nil)
	case cmd == "repo judge" && len(args) >= 5 && args[2] == "set":
		backend := flags.String("backend", "", "judge backend")
		model := flags.String("model", "", "pinned model, name@version")
		baseURL := flags.String("base-url", "", "backend base URL")
		if err := parse(flags, args[5:]); err != nil {
			return err
		}
		body := map[string]any{"backend": *backend, "model_version": *model}
		if *baseURL != "" {
			body["base_url"] = *baseURL
		}
		return call(http.MethodPut, "/api/repos/"+esc(args[3])+"/judges/"+esc(args[4]), body)
	case cmd == "change new" && len(args) >= 4:
		target := flags.String("target", "", "target branch")
		dir := flags.String("acceptance", "", "directory of acceptance files")
		draft := flags.Bool("draft", false, "store the change as a draft until change ready")
		if err := parse(flags, args[4:]); err != nil {
			return err
		}
		body := map[string]any{"intent": args[3]}
		if *target != "" {
			body["target_branch"] = *target
		}
		if *dir != "" {
			files, err := readTree(*dir)
			if err != nil {
				return err
			}
			body["acceptance"] = files
		}
		if *draft {
			body["draft"] = true
		}
		return call(http.MethodPost, "/api/repos/"+esc(args[2])+"/changes", body)
	case cmd == "change ls" && len(args) == 3:
		return call(http.MethodGet, "/api/repos/"+esc(args[2])+"/changes", nil)
	case cmd == "change show" && len(args) == 3:
		return call(http.MethodGet, "/api/changes/"+esc(args[2]), nil)
	case cmd == "change ready" && len(args) == 3:
		return call(http.MethodPost, "/api/changes/"+esc(args[2])+"/ready", nil)
	case cmd == "change retry" && len(args) == 3:
		return call(http.MethodPost, "/api/changes/"+esc(args[2])+"/retry", nil)
	case cmd == "runner register" && len(args) >= 3:
		kinds := flags.String("kinds", "", "comma-separated job kinds")
		poolToken := flags.String("pool-token", os.Getenv("CINDER_POOL_TOKEN"), "pool token that registers into its BYO pool")
		if err := parse(flags, args[3:]); err != nil {
			return err
		}
		if *kinds == "" {
			return errors.New("--kinds is required")
		}
		if token == "" && *poolToken == "" {
			return errors.New("CINDER_TOKEN or --pool-token (CINDER_POOL_TOKEN) must be set")
		}
		body := map[string]any{"name": args[2], "kinds": strings.Split(*kinds, ",")}
		if *poolToken != "" {
			body["pool_token"] = *poolToken
		}
		return call(http.MethodPost, "/api/runners", body)
	case cmd == "runner revoke" && len(args) == 3:
		return call(http.MethodDelete, "/api/workers/"+esc(args[2]), nil)
	case strings.HasPrefix(cmd, "env ") && os.Getenv("CINDER_REPO") == "":
		return errors.New("CINDER_REPO must be set for env commands")
	case cmd == "env ls" && len(args) == 2:
		return call(http.MethodGet, "/api/repos/"+esc(os.Getenv("CINDER_REPO"))+"/environments", nil)
	case cmd == "env sync" && len(args) == 3:
		return call(http.MethodPost, "/api/repos/"+esc(os.Getenv("CINDER_REPO"))+"/environments/"+esc(args[2])+"/sync", nil)
	case cmd == "env rollback" && len(args) >= 3:
		reason := flags.String("reason", "", "why the environment is rolled back")
		if err := parse(flags, args[3:]); err != nil {
			return err
		}
		if strings.TrimSpace(*reason) == "" {
			return errors.New("--reason is required")
		}
		return call(http.MethodPost, "/api/repos/"+esc(os.Getenv("CINDER_REPO"))+"/environments/"+esc(args[2])+"/rollback", map[string]any{"reason": *reason})
	}
	return errors.New(usage)
}

// verifyCommit checks that sha carries a good SSH signature by the repo's signing key, read from --key.
func verifyCommit(sha string, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("verify-commit", flag.ContinueOnError)
	key := flags.String("key", "", "file holding the repo's public signing key")
	if err := parse(flags, args); err != nil {
		return err
	}
	pub, err := os.ReadFile(*key)
	if err != nil {
		return err
	}
	signers, err := os.CreateTemp("", "cinder-signers-")
	if err != nil {
		return err
	}
	defer os.Remove(signers.Name())
	_, err = fmt.Fprintf(signers, "cinder %s\n", bytes.TrimSpace(pub))
	if cerr := signers.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	res, err := exec.Command("git", "-c", "gpg.ssh.allowedSignersFile="+signers.Name(), "verify-commit", "--", sha).CombinedOutput()
	if err != nil {
		return fmt.Errorf("verify-commit %s: %w: %s", sha, err, bytes.TrimSpace(res))
	}
	_, err = out.Write(res)
	return err
}

// parse parses flags and rejects leftover arguments, so a misplaced flag isn't silently ignored.
func parse(flags *flag.FlagSet, args []string) error {
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	return nil
}

type file struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// readTree returns every regular file under dir with its slash-separated path relative to dir.
func readTree(dir string) ([]file, error) {
	var files []file
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		files = append(files, file{filepath.ToSlash(rel), string(b)})
		return err
	})
	if err == nil && len(files) == 0 {
		err = fmt.Errorf("%s: no acceptance files", dir)
	}
	return files, err
}

// send calls the API and copies the response body to out. Errors never include the request, so the token can't leak.
func send(base, token, method, path string, body any, out io.Writer) error {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return err
		}
	}
	req, err := http.NewRequest(method, strings.TrimSuffix(base, "/")+path, &buf)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	api.SetAccess(req.Header)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%s %s: status %d: %s", method, path, resp.StatusCode, bytes.TrimSpace(msg))
	}
	_, err = io.Copy(out, resp.Body)
	return err
}
