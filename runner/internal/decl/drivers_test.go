package decl

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// mergeRepo commits base on main, side on a branch and ours on main, installs
// the drivers, merges the branch and returns the repo dir. setup runs before each commit.
func mergeRepo(t *testing.T, base, ours, theirs map[string]string, setup func(dir string)) string {
	t.Helper()
	dir := t.TempDir()
	run := func(name string, args ...string) {
		t.Helper()
		cmd := exec.Command(name, args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
	}
	git := func(args ...string) {
		t.Helper()
		run("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
	}
	commit := func(files map[string]string) {
		t.Helper()
		for n, s := range files {
			if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, n)), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, n), []byte(s), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		setup(dir)
		git("add", ".")
		git("commit", "-qm", "c")
	}
	git("init", "-q", "-b", "main")
	commit(base)
	git("checkout", "-qb", "side")
	commit(theirs)
	git("checkout", "-q", "main")
	commit(ours)
	if err := InstallDriver(dir, "false"); err != nil {
		t.Fatal(err)
	}
	git("merge", "-q", "--no-edit", "side")
	return dir
}

func TestDrivers_TwoDependencyAdditions_ProduceValidLockfile(t *testing.T) {
	deps := t.TempDir()
	for _, n := range []string{"b", "c"} {
		if err := os.MkdirAll(filepath.Join(deps, n), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(deps, n, "package.json"), []byte(`{"name":"`+n+`","version":"1.0.0"}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The additions are lines apart so package.json itself merges cleanly.
	pkg := func(dep, dev string) map[string]string {
		return map[string]string{"package.json": "{\n\"name\": \"t\",\n\"dependencies\": {" + dep + "},\n\"version\": \"1.0.0\",\n\"private\": true,\n\"devDependencies\": {" + dev + "}\n}\n"}
	}
	lock := func(dir string) {
		cmd := exec.Command("npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund")
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("npm: %v\n%s", err, out)
		}
	}
	dir := mergeRepo(t, pkg("", ""), pkg("", `"c": "file:`+filepath.Join(deps, "c")+`"`), pkg(`"b": "file:`+filepath.Join(deps, "b")+`"`, ""), lock)
	cmd := exec.Command("npm", "ls", "--package-lock-only", "--all")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("npm ls: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "b@1.0.0") || !strings.Contains(string(out), "c@1.0.0") {
		t.Errorf("lockfile lacks a dependency:\n%s", out)
	}
}

func TestDrivers_ChangelogEntriesFromBothSidesSurvive(t *testing.T) {
	head := "# Changelog\n\n"
	dir := mergeRepo(t, map[string]string{"CHANGELOG.md": head}, map[string]string{"CHANGELOG.md": head + "- ours\n"}, map[string]string{"CHANGELOG.md": head + "- theirs\n"}, func(string) {})
	b, err := os.ReadFile(filepath.Join(dir, "CHANGELOG.md"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(b); !strings.Contains(got, "- ours\n") || !strings.Contains(got, "- theirs\n") || strings.Contains(got, "<<<<<<<") {
		t.Errorf("CHANGELOG.md merged to:\n%s", got)
	}
}

func TestDrivers_TwoMigration0007Files_Become0007And0008(t *testing.T) {
	base := map[string]string{"migrations/0006_base.sql": "-- base\n"}
	dir := mergeRepo(t, base, map[string]string{"migrations/0007_ours.sql": "-- ours\n"}, map[string]string{"migrations/0007_theirs.sql": "-- theirs\n"}, func(string) {})
	ents, err := os.ReadDir(filepath.Join(dir, "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range ents {
		got = append(got, e.Name())
	}
	if want := "0006_base.sql 0007_theirs.sql 0008_ours.sql"; strings.Join(got, " ") != want {
		t.Errorf("migrations = %v, want %s", got, want)
	}
}
