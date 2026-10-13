package decl

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// mergeCase fails unless git's line merge conflicts and Merge returns want
// with ok == wantOK. An empty want means "git's line-merge result".
func mergeCase(t *testing.T, lang, base, ours, theirs, want string, wantOK bool) {
	t.Helper()
	line, clean, err := lineMerge([]byte(base), []byte(ours), []byte(theirs))
	if err != nil || clean {
		t.Fatalf("git merge-file: clean=%v err=%v; want a conflict", clean, err)
	}
	if want == "" {
		want = string(line)
	}
	got, ok, err := Merge([]byte(base), []byte(ours), []byte(theirs), lang)
	if err != nil || ok != wantOK || string(got) != want {
		t.Fatalf("Merge = %q, ok=%v, err=%v; want %q, ok=%v", got, ok, err, want, wantOK)
	}
}

func TestMergeBothAppendFuncs(t *testing.T) {
	t.Run("go", func(t *testing.T) {
		base := "package p\n\nfunc A() {}\n"
		mergeCase(t, "go", base, base+"\nfunc B() {}\n", base+"\nfunc C() {}\n",
			"package p\n\nfunc A() {}\n\nfunc C() {}\n\nfunc B() {}\n", true)
	})
	t.Run("js", func(t *testing.T) {
		base := "function a() {}\n"
		mergeCase(t, "js", base, base+"function b() {}\n", base+"function c() {}\n",
			"function a() {}\nfunction c() {}\nfunction b() {}\n", true)
	})
}

func TestMergeImportBothAdd(t *testing.T) {
	imp := func(extra string) string {
		return "package p\n\nimport (\n\t\"fmt\"\n" + extra + ")\n\nvar _ = fmt.Sprint\n"
	}
	mergeCase(t, "go", imp(""), imp("\t\"strings\"\n"), imp("\t\"os\"\n"),
		imp("\t\"os\"\n\t\"strings\"\n"), true)
}

func TestMergeEditsDifferentFuncsSameHunk(t *testing.T) {
	mergeCase(t, "js",
		"function a() { return 1 }\nfunction b() { return 2 }\n",
		"function a() { return 10 }\nfunction b() { return 2 }\n",
		"function a() { return 1 }\nfunction b() { return 20 }\n",
		"function a() { return 10 }\nfunction b() { return 20 }\n", true)
}

func TestMergeSameKeyDifferentAdd(t *testing.T) {
	base := "package p\n\nfunc A() {}\n"
	mergeCase(t, "go", base, base+"\nfunc B() int { return 1 }\n", base+"\nfunc B() int { return 2 }\n", "", false)
}

func TestMergeDeleteVsModify(t *testing.T) {
	base := "package p\n\nfunc A() int { return 1 }\n\nfunc B() {}\n"
	mergeCase(t, "go", base, "package p\n\nfunc B() {}\n", "package p\n\nfunc A() int { return 2 }\n\nfunc B() {}\n", "", false)
}

func TestMergeSafetyFallback(t *testing.T) {
	// Without a final newline, theirs' addition runs into ours' ("3const"),
	// so the re-split loses a declaration.
	mergeCase(t, "js", "const a = 1\n", "const a = 1\nconst b = 2\n", "const a = 1\nconst c = 3", "", false)
}

func TestRelock_DoesNotSeeRunnerToken(t *testing.T) {
	dir, bin := t.TempDir(), t.TempDir()
	envFile := filepath.Join(t.TempDir(), "env")
	// A fake npm records the environment a repo's .npmrc would be expanded in.
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\nenv > "+envFile+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "."}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"}} {
		if args[0] == "add" {
			for n, s := range map[string]string{"package.json": "{}\n", "package-lock.json": "{}\n"} {
				if err := os.WriteFile(filepath.Join(dir, n), []byte(s), 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"x"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CINDER_RUNNER_TOKEN", "runner-secret")
	t.Setenv("GIT_CONFIG_VALUE_0", "Authorization: Bearer artifacts-secret")
	if err := Relock(dir); err != nil {
		t.Fatal(err)
	}
	env, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"CINDER_", "GIT_CONFIG_", "runner-secret", "artifacts-secret"} {
		if strings.Contains(string(env), leak) {
			t.Errorf("npm saw %q in its environment:\n%s", leak, env)
		}
	}
}
