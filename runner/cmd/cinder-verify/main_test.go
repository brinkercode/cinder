package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/decl"
)

// git runs this test binary as the merge driver; main handles that call.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "merge-driver" {
		main()
	}
	os.Exit(m.Run())
}

func TestDriverResolvesAdjacentAdds(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) error {
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput()
		if err != nil {
			t.Logf("git %v: %s", args, out)
		}
		return err
	}
	write := func(name, s string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	base := map[string]string{"a.go": "package a\n\nfunc A() {}\n", "a.js": "export function a() {}\n"}
	add := func(name string) map[string]string {
		return map[string]string{"a.go": base["a.go"] + "\nfunc " + name + "() {}\n", "a.js": base["a.js"] + "\nexport function " + name + "() {}\n"}
	}
	commit := func(files map[string]string) {
		for n, s := range files {
			write(n, s)
		}
		if err := git("add", "."); err != nil {
			t.Fatal(err)
		}
		if err := git("commit", "-qm", "c"); err != nil {
			t.Fatal(err)
		}
	}
	if err := git("init", "-q", "-b", "main"); err != nil {
		t.Fatal(err)
	}
	commit(base)
	if err := git("checkout", "-qb", "side"); err != nil {
		t.Fatal(err)
	}
	commit(add("B"))
	if err := git("checkout", "-q", "main"); err != nil {
		t.Fatal(err)
	}
	commit(add("C"))
	if err := decl.InstallDriver(dir, os.Args[0]); err != nil {
		t.Fatal(err)
	}
	if err := git("merge", "-q", "--no-edit", "side"); err != nil {
		t.Fatalf("merge conflicted: %v", err)
	}
	for name, want := range map[string]string{
		"a.go": "package a\n\nfunc A() {}\n\nfunc B() {}\n\nfunc C() {}\n",
		"a.js": "export function a() {}\n\nexport function B() {}\n\nexport function C() {}\n",
	} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != want {
			t.Errorf("%s merged to:\n%s\nwant:\n%s", name, b, want)
		}
	}
}

func TestSymbolsGoJS(t *testing.T) {
	t.Setenv("PATH", "") // no ctags to fall back on
	dir := t.TempDir()
	files := map[string]string{
		"a.go": `package a

// T is a thing.
type T struct {
	X, Y int
	Z    string
}

func (t *T) M() int {
	return t.X
}

func F() {}
`,
		"web/b.jsx": `import x from "x";

/** C renders. */
export class C extends x {
  static make() {
    return new C();
  }
  n = 1;
  render() {
    return <div>{\` + "`${this.n}`" + `}</div>;
  }
}

export const k = 1;
`,
	}
	for n, s := range files {
		p := filepath.Join(dir, n)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	if err := listSymbols(&out, dir); err != nil {
		t.Fatal(err)
	}
	var got []string
	dec := json.NewDecoder(&out)
	for dec.More() {
		var s decl.Symbol
		if err := dec.Decode(&s); err != nil {
			t.Fatal(err)
		}
		got = append(got, fmt.Sprintf("%s %s %s %d-%d %s", s.Name, s.Kind, s.Path, s.Line, s.End, s.Scope))
	}
	want := []string{
		"T struct a.go 4-7 ",
		"X member a.go 5-5 T",
		"Y member a.go 5-5 T",
		"Z member a.go 6-6 T",
		"M func a.go 9-11 T",
		"F func a.go 13-13 ",
		"C class web/b.jsx 4-12 ",
		"make method web/b.jsx 5-7 C",
		"render method web/b.jsx 9-11 C",
		"k variable web/b.jsx 14-14 ",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d symbols %+v, want %+v", len(got), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("symbol %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestVerifyJob_CheckFails_ReportsFailedWithLog(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	git := func(args ...string) {
		if out, err := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q", "--bare", "-b", "main", target)
	git("clone", "-q", target, work)
	git("-C", work, "commit", "-q", "--allow-empty", "-m", "init")
	git("-C", work, "push", "-q", "origin", "HEAD:refs/heads/main")
	git("clone", "-q", "--bare", target, fork)
	// The fork's head adds the file the check looks for; the check fails on it.
	if err := os.WriteFile(filepath.Join(work, "verdict.txt"), []byte("broken by the fork"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("-C", work, "add", ".")
	git("-C", work, "commit", "-q", "-m", "fork change")
	git("-C", work, "push", "-q", fork, "HEAD:refs/heads/main")

	rep := run(context.Background(), &api.Claim{
		Job:    api.Job{ID: "v1", Kind: "verify"},
		Change: &api.Change{ID: "c1", TargetBranch: "main"}, ForkRemote: fork, TargetRemote: target,
		Payload: json.RawMessage(`{"check":"cat verdict.txt; exit 1"}`),
	})
	if rep.Status != "failed" || !strings.Contains(rep.Detail, "broken by the fork") {
		t.Fatalf("report = %+v, want failed with the check's log", rep)
	}
}

func TestVerifyJob_HeadSHA_ChecksThatCommit(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	target, fork, work := filepath.Join(root, "target.git"), filepath.Join(root, "fork.git"), filepath.Join(root, "work")
	git := func(args ...string) string {
		out, err := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "--bare", "-b", "main", target)
	git("clone", "-q", target, work)
	git("-C", work, "commit", "-q", "--allow-empty", "-m", "init")
	git("-C", work, "push", "-q", "origin", "HEAD:refs/heads/main")
	git("clone", "-q", "--bare", target, fork)
	// A person's branch on the fork, not its target branch, holds the commit the job names.
	if err := os.WriteFile(filepath.Join(work, "verdict.txt"), []byte("on the head commit"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("-C", work, "add", ".")
	git("-C", work, "commit", "-q", "-m", "person's change")
	git("-C", work, "push", "-q", fork, "HEAD:refs/heads/feature")
	sha := git("-C", work, "rev-parse", "HEAD")

	rep := run(context.Background(), &api.Claim{
		Job:    api.Job{ID: "v2", Kind: "verify"},
		Change: &api.Change{ID: "c2", TargetBranch: "main"}, ForkRemote: fork, TargetRemote: target,
		Payload: json.RawMessage(`{"check":"cat verdict.txt; exit 1","head_sha":"` + sha + `"}`),
	})
	if rep.Status != "failed" || !strings.Contains(rep.Detail, "on the head commit") {
		t.Fatalf("report = %+v, want the check run on %s", rep, sha)
	}
}

func TestRefsJob_ListsBranchesFromLsRemote(t *testing.T) {
	root := t.TempDir()
	remote, work := filepath.Join(root, "remote.git"), filepath.Join(root, "work")
	for _, args := range [][]string{
		{"init", "-q", "--bare", "-b", "main", remote},
		{"clone", "-q", remote, work},
		{"-C", work, "commit", "-q", "--allow-empty", "-m", "init"},
		{"-C", work, "push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/develop", "HEAD:refs/tags/v1"},
	} {
		if out, err := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	rep := run(context.Background(), &api.Claim{Job: api.Job{Kind: "refs"}, TargetRemote: remote})
	if rep.Status != "done" || strings.Join(rep.Refs, ",") != "develop,main" {
		t.Fatalf("report = %+v, want done with refs develop,main", rep)
	}
}
