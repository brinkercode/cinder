package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/verify"
)

func TestMerge_TrailersPresentAfterMerge(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "change")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, work, "push", "--quiet", fork, "main")

	head, err := merge(context.Background(), "", target, "main", []landing{{Change: "chg_1", Remote: fork, Tree: gitOut(t, fork, "rev-parse", "main^{tree}")}}, "dev", 3, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, target, "rev-parse", "main"); got != head {
		t.Fatalf("target main = %s, merge returned %s", got, head)
	}
	want := "Cinder-Change: chg_1\nCinder-Agent: dev@v3\nCinder-Agent-Version: dev@v3"
	if got := gitOut(t, target, "log", "-1", "--format=%(trailers:only)", "main"); got != want {
		t.Fatalf("trailers = %q, want %q", got, want)
	}
}

func TestMerge_SubjectStartsWithChangeKey(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "change")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, work, "push", "--quiet", fork, "main")

	l := landing{Change: "chg_1", Key: "PULSE-6", Title: "Declined cards retry forever", Remote: fork, Tree: gitOut(t, fork, "rev-parse", "main^{tree}")}
	if _, err := merge(context.Background(), "", target, "main", []landing{l}, "dev", 3, nil); err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, target, "log", "-1", "--format=%s", "main"); got != "PULSE-6: Declined cards retry forever" {
		t.Fatalf("subject = %q", got)
	}
	if got := gitOut(t, target, "log", "-1", "--format=%(trailers:key=Cinder-Change,valueonly)", "main"); got != "chg_1" {
		t.Fatalf("Cinder-Change = %q", got)
	}
}

func TestMerge_BatchLandsInOrderAndRefusesAnUnverifiedTree(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, work := filepath.Join(root, "target.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	// Two forks of base, each adding its own file; b's verified tree has both files, as its speculative verify built it.
	var batch []landing
	for _, x := range []string{"a", "b"} {
		gitOut(t, work, "checkout", "--quiet", "-B", x, "main")
		if err := os.WriteFile(filepath.Join(work, x), []byte(x), 0o600); err != nil {
			t.Fatal(err)
		}
		gitOut(t, work, "add", x)
		gitOut(t, work, "commit", "--quiet", "-m", x)
		fork := filepath.Join(root, x+".git")
		gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
		gitOut(t, work, "push", "--quiet", fork, x+":main")
		batch = append(batch, landing{Change: x, Remote: fork})
	}
	gitOut(t, work, "checkout", "--quiet", "a")
	gitOut(t, work, "merge", "--quiet", "--no-edit", "b")
	batch[0].Tree, batch[1].Tree = gitOut(t, batch[0].Remote, "rev-parse", "main^{tree}"), gitOut(t, work, "rev-parse", "HEAD^{tree}")
	before := gitOut(t, target, "rev-parse", "main")

	stale := append([]landing{batch[0]}, landing{Change: "b", Remote: batch[1].Remote, Tree: batch[0].Tree})
	if _, err := merge(context.Background(), "", target, "main", stale, "dev", 3, nil); err == nil || !strings.Contains(err.Error(), "merge refused: change b") {
		t.Fatalf("err = %v, want b refused", err)
	}
	if got := gitOut(t, target, "rev-parse", "main"); got != before {
		t.Fatalf("a refused batch pushed %s", got)
	}
	if _, err := merge(context.Background(), "", target, "main", batch, "dev", 3, nil); err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, target, "log", "--first-parent", "--format=%(trailers:key=Cinder-Change,valueonly)", "-2", "main"); got != "b\n\na" {
		t.Fatalf("landed = %q, want b on top of a", got)
	}
}

func TestMerge_SignsThroughWorkerEndpoint(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work, key := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work"), filepath.Join(root, "key")
	if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v: %s", err, out)
	}
	pub, err := os.ReadFile(key + ".pub") // what GET /api/repos/:name/signing-key serves
	if err != nil {
		t.Fatal(err)
	}
	// The Worker's sign endpoint: holds the key, signs the commit object the runner sends.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Commit string }
		if r.URL.Path != "/api/work/jobs/m1/sign" || r.Header.Get("Authorization") != "Bearer rt" || json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad sign request", http.StatusBadRequest)
			return
		}
		cmd := exec.Command("ssh-keygen", "-Y", "sign", "-n", "git", "-f", key)
		cmd.Stdin = strings.NewReader(body.Commit)
		sig, err := cmd.Output()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"signature": string(sig)})
	}))
	defer srv.Close()
	client := &api.Client{BaseURL: srv.URL, Token: "rt"}
	sign := func(commit string) (string, error) { return client.SignMerge(context.Background(), "m1", commit) }
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "change")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, work, "push", "--quiet", fork, "main")

	head, err := merge(context.Background(), "", target, "main", []landing{{Change: "chg_1", Remote: fork, Tree: gitOut(t, fork, "rev-parse", "main^{tree}")}}, "dev", 3, sign)
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, target, "rev-parse", "main"); got != head {
		t.Fatalf("target main = %s, merge returned %s", got, head)
	}
	signers := filepath.Join(root, "allowed")
	if err := os.WriteFile(signers, append([]byte("cinder "), pub...), 0o600); err != nil {
		t.Fatal(err)
	}
	gitOut(t, target, "-c", "gpg.ssh.allowedSignersFile="+signers, "verify-commit", head)
	if got := gitOut(t, target, "log", "-1", "--format=%(trailers:key=Cinder-Change,valueonly)", "main"); got != "chg_1" {
		t.Fatalf("Cinder-Change = %q, want chg_1", got)
	}
}

// verifiedBehind makes a target that moved on after its fork branched, and runs the fork's verify. It returns the
// target, the work clone that pushes to it, and the landing that verify reported.
func verifiedBehind(t *testing.T) (string, string, landing) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "change")
	gitOut(t, work, "push", "--quiet", fork, "main")
	gitOut(t, work, "reset", "--quiet", "--hard", "HEAD~")
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "target moves on")
	gitOut(t, work, "push", "--quiet", target, "main")
	rep := verify.Run(context.Background(), filepath.Join(root, "verify"), "", verify.Job{Target: target, Branch: "main", Fork: fork, Head: "main", Check: "true"})
	if rep.Status != "done" {
		t.Fatalf("verify: %+v", rep)
	}
	return target, work, landing{Change: "chg_1", Remote: fork, Tree: rep.Tree, Base: rep.Base}
}

func TestMerge_VerifiedTreeMatches_Pushes(t *testing.T) {
	target, _, l := verifiedBehind(t)
	head, err := merge(context.Background(), "", target, "main", []landing{l}, "dev", 3, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, target, "rev-parse", "main"); got != head || gitOut(t, target, "rev-parse", "main^1") != l.Base {
		t.Fatalf("target main = %s, want the merge %s onto the verified base %s", got, head, l.Base)
	}
}

func TestMerge_TargetMoved_RefusesWithBothShas(t *testing.T) {
	target, work, l := verifiedBehind(t)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "target moves again")
	gitOut(t, work, "push", "--quiet", target, "main")
	moved := gitOut(t, target, "rev-parse", "main")
	_, err := merge(context.Background(), "", target, "main", []landing{l}, "dev", 3, nil)
	if err == nil || !strings.Contains(err.Error(), moved) || !strings.Contains(err.Error(), l.Base) {
		t.Fatalf("err = %v, want a refusal naming %s and %s", err, moved, l.Base)
	}
	if got := gitOut(t, target, "rev-parse", "main"); got != moved {
		t.Fatalf("a refused merge pushed %s", got)
	}
}

func TestMerge_HeadOnlyUnderRefsFor_LandsTheHead(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", target)
	gitOut(t, root, "init", "--quiet", "--bare", "-b", "main", fork)
	gitOut(t, root, "init", "--quiet", "-b", "main", work)
	gitOut(t, work, "commit", "--quiet", "--allow-empty", "-m", "base")
	gitOut(t, work, "push", "--quiet", target, "main")
	gitOut(t, work, "push", "--quiet", fork, "main")
	// A person's push: the fork's main stays at base, the change's commit is only under refs/for/main.
	if err := os.WriteFile(filepath.Join(work, "note.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitOut(t, work, "add", "note.txt")
	gitOut(t, work, "commit", "--quiet", "-m", "change")
	head := gitOut(t, work, "rev-parse", "HEAD")
	gitOut(t, work, "push", "--quiet", fork, "HEAD:refs/for/main")
	rep := verify.Run(context.Background(), filepath.Join(root, "verify"), "", verify.Job{Target: target, Branch: "main", Fork: fork, Head: head, Check: "true"})
	if rep.Status != "done" {
		t.Fatalf("verify: %+v", rep)
	}
	l := landing{Change: "chg_1", Head: head, Remote: fork, Tree: rep.Tree, Base: rep.Base}
	merged, err := merge(context.Background(), "", target, "main", []landing{l}, "dev", 3, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, target, "rev-parse", merged+"^2"); got != head {
		t.Fatalf("merge's second parent = %s, want the change's head %s", got, head)
	}
}
