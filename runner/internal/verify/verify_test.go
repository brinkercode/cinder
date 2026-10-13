package verify

import (
	"context"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/brinkercode/cinder/runner/internal/api"
)

// repos makes a target repo whose main has test/acc.sh, and a fork whose main
// edits test/acc.sh to pass. It returns the job pointing at both.
func repos(t *testing.T) Job {
	tmp := t.TempDir()
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main target; mkdir target/test; echo 'echo target; exit 1' > target/test/acc.sh
git -C target add .; git -C target commit -qm target; git clone -q target fork
echo 'echo fork; exit 0' > fork/test/acc.sh; git -C fork commit -qam 'fork weakens the acceptance test'`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	return Job{Target: filepath.Join(tmp, "target"), Branch: "main", Fork: filepath.Join(tmp, "fork"), Head: "main", Check: "sh test/acc.sh"}
}

// checkLog is a verify's detail after its Fetch change and Check leases steps: the check's own output.
func checkLog(detail string) string {
	return detail[strings.LastIndex(detail, "##[endgroup]\n")+len("##[endgroup]\n"):]
}

func TestVerify_ReportsFetchAndLeaseSteps(t *testing.T) {
	j := repos(t)
	j.Check, j.Leases = "echo checked", []Lease{{Symbol: "test/acc.sh#run", Holder: "c-7"}, {Symbol: "other.go", Holder: "c-8"}}
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	want := []string{"##[group]Fetch change", "Fetching main against main @ " + rep.Base[:7], " test/acc.sh | 2 +-",
		" 1 file changed, 1 insertion(+), 1 deletion(-)", "##[endgroup]", "##[group]Check leases", "Lease test/acc.sh#run · c-7", "##[endgroup]", "checked", ""}
	if got := strings.Split(rep.Detail, "\n"); rep.Status != "done" || strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("detail =\n%s\nwant\n%s", rep.Detail, strings.Join(want, "\n"))
	}
	j.Leases = nil
	if rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j); !strings.Contains(rep.Detail, "\nLease test/acc.sh · none\n") {
		t.Fatalf("detail =\n%s\nwant the unleased file listed with none", rep.Detail)
	}
}

func TestRun_OverlayReplacesForkEditedAcceptanceFile(t *testing.T) {
	j := repos(t)
	j.Acceptance = map[string]string{"test/acc.sh": "echo overlay > results.txt; echo overlay ran; exit 3\n"}
	j.Results = "results.txt"
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if rep.Status != "failed" || !strings.Contains(rep.Detail, "overlay ran") || strings.Contains(rep.Detail, "fork") {
		t.Fatalf("want the overlaid test to run and fail, got %+v", rep)
	}
	if rep.Results != "overlay\n" {
		t.Fatalf("results = %q, want the result file the check wrote", rep.Results)
	}
}

func TestRun_Only_PassesFailedTestsToCheck(t *testing.T) {
	j := repos(t)
	j.Check, j.Only = `printf '[%s]' "$CINDER_ONLY_TESTS"`, []string{"retry backs off", "jitter is zero"}
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if rep.Status != "done" || checkLog(rep.Detail) != "[retry backs off\njitter is zero]" {
		t.Fatalf("want the check to see the failed tests, got %+v", rep)
	}
}

func TestRun_Check_DoesNotSeeRunnerToken(t *testing.T) {
	t.Setenv("CINDER_RUNNER_TOKEN", "runner-secret")
	j := repos(t)
	j.Check = `printf '[%s]' "$CINDER_RUNNER_TOKEN"`
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if rep.Status != "done" || checkLog(rep.Detail) != "[]" {
		t.Fatalf("want the check to run without the runner token, got %+v", rep)
	}
}

func TestRun_Check_TrustsTheContainersCA(t *testing.T) {
	t.Setenv("NODE_EXTRA_CA_CERTS", "/etc/ca.crt")
	t.Setenv("CINDER_RUNNER_TOKEN", "runner-secret")
	j := repos(t)
	j.Check = `printf '[%s][%s]' "$NODE_EXTRA_CA_CERTS" "$CINDER_RUNNER_TOKEN"`
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if rep.Status != "done" || checkLog(rep.Detail) != "[/etc/ca.crt][]" {
		t.Fatalf("want the check to see the CA file and no token, got %+v", rep)
	}
}

func TestRun_CheckTimeout_ReportsFailNotHang(t *testing.T) {
	j := repos(t)
	j.Check, j.Timeout = "sleep 30; echo late", 200*time.Millisecond
	start := time.Now()
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if took := time.Since(start); took > 10*time.Second {
		t.Fatalf("Run took %s, want it to stop at the timeout", took)
	}
	if rep.Status != "failed" || !strings.Contains(rep.Detail, "timed out") {
		t.Fatalf("want a timed-out failure, got %+v", rep)
	}
}

func TestRun_AheadChanges_ChecksOutTargetPlusAheadMergedInOrder(t *testing.T) {
	tmp := t.TempDir()
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main target; git -C target commit -q --allow-empty -m target
for x in a b own; do git clone -q target $x; echo $x > $x/$x.txt; git -C $x add .; git -C $x commit -qm $x; done`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	// HEAD merges own onto (target + a) + b: each second parent, walking the first parents back, names the order.
	j := Job{Target: filepath.Join(tmp, "target"), Branch: "main", Fork: filepath.Join(tmp, "own"), Head: "main",
		Ahead: []Ahead{{Remote: filepath.Join(tmp, "a"), Head: "main"}, {Remote: filepath.Join(tmp, "b"), Head: "main"}},
		Check: `test -f a.txt -a -f b.txt -a -f own.txt && git show -s --format=%s HEAD^2 HEAD^1^2 HEAD^1^1^2 HEAD^1^1^1 | tr '\n' ' '`}
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if rep.Status != "done" || !strings.Contains(rep.Detail, "own b a target") || len(rep.Tree) != 40 {
		t.Fatalf("want own merged onto target + a + b and its tree reported, got %+v", rep)
	}
}

// sarifRepos is repos with a fork that changes line 2 of a.go; its check writes out.sarif
// with one finding on line 1 (untouched) and one on line 2 (changed).
func sarifRepos(t *testing.T) Job {
	j := repos(t)
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
printf 'one\ntwo\nthree\n' > target/a.go; git -C target add a.go; git -C target commit -qm a; git -C fork pull -q --no-rebase --no-edit
printf 'one\nTWO\nthree\n' > fork/a.go; git -C fork commit -qam 'change line 2'`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = filepath.Dir(j.Target)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	j.Check = `cat > out.sarif <<'S'
{"version":"2.1.0","runs":[{"results":[
{"ruleId":"untouched-rule","locations":[{"physicalLocation":{"artifactLocation":{"uri":"a.go"},"region":{"startLine":1}}}]},
{"ruleId":"G101","locations":[{"physicalLocation":{"artifactLocation":{"uri":"a.go"},"region":{"startLine":2}}}]}]}]}
S`
	return j
}

func TestRun_SarifFindingOnChangedLine_IsReported(t *testing.T) {
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", sarifRepos(t))
	if rep.Status != "done" || len(rep.Findings) == 0 || rep.Findings[0] != (api.Finding{Rule: "G101", File: "a.go", Line: 2}) {
		t.Fatalf("want the G101 finding on a.go:2 reported, got %+v", rep)
	}
}

func TestRun_SarifFindingOnUntouchedLine_IsIgnored(t *testing.T) {
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", sarifRepos(t))
	for _, f := range rep.Findings {
		if f.Line != 2 {
			t.Fatalf("finding on untouched line reported: %+v", f)
		}
	}
	if rep.Status != "done" || len(rep.Findings) != 1 {
		t.Fatalf("want only the changed-line finding, got %+v", rep)
	}
}

// go vet and staticcheck pass with Merge removed: the package declares no Merge, which bypassed the tree check.
func TestMergeRemoved_GoVetAndStaticcheckPass(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "verify.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if f.Scope.Lookup("Merge") != nil {
		t.Fatal("verify.Merge still exists; it has no production caller")
	}
}

func TestVerify_ForkBehindTarget_ChecksMergedTree(t *testing.T) {
	j := repos(t)
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
echo new > target/new.txt; git -C target add new.txt; git -C target commit -qm 'target moves on'; git -C target rev-parse HEAD`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = filepath.Dir(j.Target)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	j.Check = "test -f new.txt && sh test/acc.sh"
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "", j)
	if rep.Status != "done" || !strings.Contains(rep.Detail, "fork") || rep.Base != strings.TrimSpace(string(out)) || len(rep.Tree) != 40 {
		t.Fatalf("want the fork merged onto the target tip and that tip reported, got %+v", rep)
	}
}

func TestRun_BloblessClone_MergeFetchesMissingBlobsWithToken(t *testing.T) {
	t.Setenv("CINDER_URL", "http://cinder.internal")
	tmp := t.TempDir()
	// Both sides edit a.txt, so the merge needs its base blob, which the blobless clone never fetched.
	script := `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main w; printf 'one\ntwo\nthree\n' > w/a.txt; git -C w add .; git -C w commit -qm base
git clone -q w fork; printf 'ONE\ntwo\nthree\n' > fork/a.txt; git -C fork commit -qam fork
printf 'one\ntwo\nTHREE\n' > w/a.txt; git -C w commit -qam target
git clone -q --bare w target.git; git -C target.git config uploadpack.allowFilter true`
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = tmp
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	backend := &cgi.Handler{Path: gitPath, Args: []string{"http-backend"}, Env: []string{"GIT_PROJECT_ROOT=" + tmp, "GIT_HTTP_EXPORT_ALL=1"}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer read-token" {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	defer srv.Close()
	j := Job{Target: srv.URL + "/target.git", Branch: "main", Fork: filepath.Join(tmp, "fork"), Head: "main", Check: "cat a.txt"}
	rep := Run(context.Background(), filepath.Join(t.TempDir(), "w"), "read-token", j)
	if rep.Status != "done" || checkLog(rep.Detail) != "ONE\ntwo\nTHREE\n" {
		t.Fatalf("want the merge to fetch the base blob with the token and the check to see both edits, got %+v", rep)
	}
}
