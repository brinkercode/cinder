package decl

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// wantKeys splits src and fails unless the keys are want, in order.
func wantKeys(t *testing.T, src string, want ...string) []Decl {
	t.Helper()
	ds, err := SplitJS([]byte(src))
	var got []string
	for _, d := range ds {
		got = append(got, d.Key)
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("SplitJS = %q, %v; want %q", got, err, want)
	}
	return ds
}

func TestScanJSRoundTrip(t *testing.T) {
	src := `// header
import React from "react";
import { a,
  b } from './ab.js'
import './side.css'

/** Doc for f. */
export async function f(x) {
  return x / 2 // half
}
class A extends B { m() { return 1 } }
const { p, q } = obj; let z = 1
setup()
  .then(run)
export { a as c }
`
	ds := wantKeys(t, src, "import:react", "import:./ab.js", "anchor:0", "func:f", "class:A", "var:p", "var:z", "anchor:1", "export:a")
	if f := ds[3]; !strings.HasPrefix(src[f.Start:f.End], "\n/** Doc for f. */\nexport") || f.StartLine != 6 || f.EndLine != 10 {
		t.Fatalf("func f = %q lines %d-%d", src[f.Start:f.End], f.StartLine, f.EndLine)
	}
	// Every JS file in the repo, plus the sample, splits and reproduces itself.
	files, _ := filepath.Glob("../../../*/src/*.js*")
	for _, p := range append(files, "") {
		b := []byte(src)
		if p != "" {
			b, _ = os.ReadFile(p)
		}
		ds, err := SplitJS(b)
		end := 0
		for _, d := range ds {
			if d.Start != end || d.Text != string(b[d.Start:d.End]) {
				t.Fatalf("%s: decl %q starts at %d, previous ends at %d", p, d.Key, d.Start, end)
			}
			end = d.End
		}
		if err != nil || end != len(b) {
			t.Fatalf("%s: err %v, decls end at %d of %d", p, err, end, len(b))
		}
	}
	if len(files) < 10 {
		t.Fatal("no repo JS files found")
	}
}

func TestScanJSXBodyBraces(t *testing.T) {
	src := "function App({ items }) {\n" +
		"  return <ul className={cls}>\n" +
		"    {items.map(i => <li key={i}>don't {\"}\"} {i}</li>)}\n" +
		"    <>{`x ${ {b: 1}.b } }`}</>\n" +
		"  </ul>\n" +
		"}\n" +
		"const s = `a ${ { b: '}' }.b } }`\n" +
		"export const done = 1\n"
	if ds := wantKeys(t, src, "func:App", "var:s", "var:done"); ds[0].EndLine != 6 {
		t.Fatalf("App ends on line %d, want 6", ds[0].EndLine)
	}
}

func TestScanJSRegexVsDivide(t *testing.T) {
	src := "const a = b / c / d\n" +
		"const r = /[/}]+\\/{/g.test(s)\n" +
		"const q = (x) / 2 / (y)\n" +
		"function f() { return /}/ }\n" +
		"const n = i++ / 2\n" +
		"const t = `${/}/.source}` + <a>{/}/.source}</a>\n" +
		"const last = 1\n"
	wantKeys(t, src, "var:a", "var:r", "var:q", "func:f", "var:n", "var:t", "var:last")
}

func TestSplitJS_IdentifierNamedFromBeforeDivision_Splits(t *testing.T) {
	src := "const from = 4, as = 2, of = 8\n" +
		"const a = from / 2 / as\n" +
		"const b = of / 2 / 1\n" +
		"import * as\n  ns from\n  './ns.js'\n" +
		"export { a } from\n  './a.js'\n" +
		"const last = 1\n"
	wantKeys(t, src, "var:from", "var:a", "var:b", "import:./ns.js", "export:./a.js", "var:last")
}

func TestScanJSExportDefaultKey(t *testing.T) {
	// Renaming the default export keeps its key, so the merge still matches it.
	wantKeys(t, "export default function Foo() {}\nexport function g() {}\n", "export:default", "func:g")
	wantKeys(t, "export default function Bar() {}\nexport function g() {}\n", "export:default", "func:g")
}

func TestScanJSUnbalancedErrors(t *testing.T) {
	for _, src := range []string{
		"function f() {",
		"const a = )",
		"const a = [1, 2)",
		"const s = 'abc\n",
		"const t = `${a`",
		"/* never closed",
		"const r = /abc\n",
		"const j = <div>{x</div>",
		"const j = <div>text",
	} {
		if _, err := SplitJS([]byte(src)); err == nil {
			t.Errorf("SplitJS(%q) = nil error, want unbalanced error", src)
		}
	}
}

func TestSymbolsJS_MarksExportedFunctions(t *testing.T) {
	src := "export function a() {}\nexport default function b() {}\nfunction c() {}\nexport { c }\nfunction d() {}\n"
	syms, err := SymbolsJS("x.js", []byte(src))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, s := range syms {
		got[s.Kind+" "+s.Name] = s.Exported
	}
	want := map[string]bool{"function a": true, "function b": true, "function c": true, "function d": false}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exported = %v; want %v", got, want)
	}
}
