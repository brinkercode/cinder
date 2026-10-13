package symbols

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/brinkercode/cinder/runner/internal/decl"
)

const src = `package p

func A() {
	println("a")
}

var x = 1

func B() {}
`

func touched(t *testing.T, diff string) []Touch {
	t.Helper()
	got, err := Touched(diff, func(path string) []decl.Symbol {
		s, err := decl.SymbolsGo(path, []byte(src))
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestTouched_HunkInsideFunction_MapsToThatFunction(t *testing.T) {
	got := touched(t, "--- a/p.go\n+++ b/p.go\n@@ -4 +4 @@ func A() {\n-\tprintln(\"old\")\n+\tprintln(\"a\")\n")
	if want := []Touch{{Path: "p.go", Name: "A"}}; !slices.Equal(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestTouched_HunkBetweenFunctions_MapsToFileTopLevel(t *testing.T) {
	got := touched(t, "--- a/p.go\n+++ b/p.go\n@@ -5,0 +6 @@ func A() {\n+\n")
	if want := []Touch{{Path: "p.go"}}; !slices.Equal(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestTouched_NewFile_CountsEverySymbolAsNew(t *testing.T) {
	got := touched(t, "--- /dev/null\n+++ b/p.go\n@@ -0,0 +1,9 @@\n+package p\n+\n+func A() {\n+\tprintln(\"a\")\n+}\n+\n+var x = 1\n+\n+func B() {}\n")
	want := []Touch{{Path: "p.go", Name: "A", New: true}, {Path: "p.go", Name: "x", New: true}, {Path: "p.go", Name: "B", New: true}, {Path: "p.go", New: true}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// diffOf commits before in a new repo, stages after over it and maps the staged diff onto symbols.
func diffOf(t *testing.T, before, after map[string]string) Changes {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	dir := t.TempDir()
	git := func(args ...string) string {
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	write := func(files map[string]string) {
		for n, src := range files {
			if err := os.MkdirAll(filepath.Join(dir, filepath.Dir(n)), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, n), []byte(src), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	git("init", "-q")
	write(before)
	git("add", "-A")
	git("commit", "-q", "-m", "before")
	write(after)
	git("add", "-A")
	all, err := Index(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Diff(git("diff", "--cached", "-U0", "--no-renames"), func(p string) []decl.Symbol {
		return File(p, []byte(before[p]))
	}, ByPath(all))
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestDiff_GoParamsChange_SignatureWrite_BodyOnlyChange_BodyWrite(t *testing.T) {
	const old = "package p\n\nfunc F(a int) int {\n\treturn a\n}\n"
	sig := diffOf(t, map[string]string{"p.go": old}, map[string]string{"p.go": "package p\n\nfunc F(a, b int) int {\n\treturn a\n}\n"})
	if want := []Write{{Symbol: "p.go#F", Kind: "signature"}}; !slices.Equal(sig.Writes, want) {
		t.Errorf("params change writes %+v, want %+v", sig.Writes, want)
	}
	body := diffOf(t, map[string]string{"p.go": old}, map[string]string{"p.go": "package p\n\nfunc F(a int) int {\n\treturn a + 1\n}\n"})
	if want := []Write{{Symbol: "p.go#F", Kind: "body"}}; !slices.Equal(body.Writes, want) {
		t.Errorf("body change writes %+v, want %+v", body.Writes, want)
	}
}

func TestDiff_ChangedCallSite_ReportsCalleeInReads(t *testing.T) {
	lib := "package lib\n\nfunc Callee() {}\n\nfunc Other() {}\n"
	got := diffOf(t,
		map[string]string{"lib/lib.go": lib, "main.go": "package main\n\nimport \"example.com/m/lib\"\n\nfunc main() {\n\tlib.Other()\n}\n"},
		map[string]string{"main.go": "package main\n\nimport \"example.com/m/lib\"\n\nfunc main() {\n\tlib.Other()\n\tlib.Callee()\n}\n"})
	want := Changes{Writes: []Write{{Symbol: "main.go#main", Kind: "body"}}, Reads: []string{"lib/lib.go#Callee"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestDiff_TypeScriptExportedTypeChange_SignatureWriteOnType(t *testing.T) {
	got := diffOf(t,
		map[string]string{"types.ts": "export type User = {\n  id: string;\n};\n\nexport function name(u: User) {\n  return u.id;\n}\n"},
		map[string]string{"types.ts": "export type User = {\n  id: string;\n  name: string;\n};\n\nexport function name(u: User) {\n  return u.id;\n}\n"})
	if want := []Write{{Symbol: "types.ts#User", Kind: "signature"}}; !slices.Equal(got.Writes, want) {
		t.Fatalf("writes %+v, want %+v", got.Writes, want)
	}
}

func TestPush_WritesCarryBaseLineRanges(t *testing.T) {
	dir := t.TempDir()
	src := "variable \"name\" {\n  description = \"Name, in lower case.\"\n  default = \"web\"\n  # kept short\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "variables.tf"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	// One hunk replaces base line 2, an insertion lands after base line 3: a file without symbols is one write.
	diff := "--- a/variables.tf\n+++ b/variables.tf\n@@ -2 +2 @@\n-  description = \"Name.\"\n+  description = \"Name, in lower case.\"\n@@ -3,0 +4 @@\n+  # kept short\n"
	_, writes, _, err := Push(dir, diff)
	if err != nil {
		t.Fatal(err)
	}
	if want := []Write{{Symbol: "variables.tf", Kind: "body", Lines: "2-2,4-3"}}; !slices.Equal(writes, want) {
		t.Fatalf("writes %+v, want %+v", writes, want)
	}
}
