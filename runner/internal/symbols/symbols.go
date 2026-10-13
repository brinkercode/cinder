// Package symbols maps a diff's hunks onto the symbols they touch.
package symbols

import (
	"bufio"
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/decl"
)

// Touch is one symbol a diff touched. Name is "" for the file's top level, "Scope.Name" for methods and members.
type Touch struct {
	Path string `json:"path"`
	Name string `json:"name"`
	New  bool   `json:"new"`
	// Signature: a changed line is the symbol's declaration line.
	Signature bool `json:"signature,omitempty"`
}

// Touched maps the hunks of diff (git diff -U0 --no-renames) onto the innermost symbol
// containing each changed line of the new file, or the file's top level when none does.
// Every symbol of a new file counts as new. syms lists a path's symbols in the new tree.
func Touched(diff string, syms func(path string) []decl.Symbol) ([]Touch, error) {
	out, _, _, err := walk(diff, syms)
	return out, err
}

// walk is Touched plus the text of every added line, by path and new line number, and each touch's base line
// ranges by [path, name]: "first-last", where an insertion after base line a is "a+1-a".
func walk(diff string, syms func(path string) []decl.Symbol) ([]Touch, map[string]map[int]string, map[[2]string][]string, error) {
	var out []Touch
	added := map[string]map[int]string{}
	ranges := map[[2]string][]string{}
	n := 0
	seen := map[[2]string]int{}
	add := func(t Touch) {
		k := [2]string{t.Path, t.Name}
		if i, ok := seen[k]; ok {
			out[i].Signature = out[i].Signature || t.Signature
			return
		}
		seen[k] = len(out)
		out = append(out, t)
	}
	var path, old string
	var list []decl.Symbol
	remaining := 0
	sc := bufio.NewScanner(strings.NewReader(diff))
	sc.Buffer(nil, 1<<24)
	for sc.Scan() {
		l := sc.Text()
		if remaining > 0 && l != "" && strings.ContainsRune("+- ", rune(l[0])) {
			remaining--
			if l[0] == '+' {
				added[path][n] = l[1:]
				n++
			}
			continue
		}
		switch {
		case strings.HasPrefix(l, "--- "):
			old = strings.TrimPrefix(l[4:], "a/")
		case strings.HasPrefix(l, "+++ "):
			path = strings.TrimPrefix(l[4:], "b/")
			added[path] = map[int]string{}
			switch {
			case path == "/dev/null": // deleted file: its top level is touched
				add(Touch{Path: old})
			case old == "/dev/null":
				list = nil
				for _, s := range syms(path) {
					add(Touch{Path: path, Name: name(s), New: true})
				}
				add(Touch{Path: path, New: true})
			default:
				list = syms(path)
			}
		case strings.HasPrefix(l, "@@ "):
			var a, b, c, d int
			if _, err := fmt.Sscanf(counts(l), "-%d,%d +%d,%d", &a, &b, &c, &d); err != nil {
				return nil, nil, nil, fmt.Errorf("symbols: bad hunk header %q: %w", l, err)
			}
			remaining, n = b+d, c
			if old == "/dev/null" || path == "/dev/null" {
				continue
			}
			// "-a,0" inserts after base line a.
			base := fmt.Sprintf("%d-%d", a, a+b-1)
			if b == 0 {
				base = fmt.Sprintf("%d-%d", a+1, a)
			}
			// A pure deletion (d == 0) sits after line c; attribute it to line c.
			for n := c; n <= max(c, c+d-1); n++ {
				name, sig := innermost(list, n)
				add(Touch{Path: path, Name: name, Signature: sig})
				if k := [2]string{path, name}; !slices.Contains(ranges[k], base) {
					ranges[k] = append(ranges[k], base)
				}
			}
		}
	}
	return out, added, ranges, sc.Err()
}

// counts rewrites "@@ -a[,b] +c[,d] @@ ..." so omitted counts read as 1.
func counts(header string) string {
	f := strings.Fields(header)
	if len(f) < 3 {
		return header
	}
	for i := 1; i <= 2; i++ {
		if !strings.Contains(f[i], ",") {
			f[i] += ",1"
		}
	}
	return f[1] + " " + f[2]
}

// innermost names the innermost symbol containing line and says whether line is its declaration line.
// lazy: scans every symbol per changed line; index by line past ~10k-line hunks.
func innermost(list []decl.Symbol, line int) (string, bool) {
	best := -1
	for i, s := range list {
		if s.Line <= line && line <= s.End && (best < 0 || s.End-s.Line < list[best].End-list[best].Line) {
			best = i
		}
	}
	if best < 0 {
		return "", false
	}
	return name(list[best]), list[best].Line == line
}

func name(s decl.Symbol) string {
	if s.Scope != "" {
		return s.Scope + "." + s.Name
	}
	return s.Name
}

var extract = map[string]func(string, []byte) ([]decl.Symbol, error){
	".go": decl.SymbolsGo, ".js": decl.SymbolsJS, ".jsx": decl.SymbolsJS, ".ts": decl.SymbolsJS, ".tsx": decl.SymbolsJS,
}

// File lists path's symbols with their hashes and unresolved reads. A file in another language, or one that
// doesn't parse, is one file-level entry: kind "file", no name, its content hash as Body.
func File(path string, src []byte) []decl.Symbol {
	if list := extract[filepath.Ext(path)]; list != nil {
		if syms, err := list(path, src); err == nil {
			return syms
		}
	}
	end := 1 + bytes.Count(bytes.TrimSuffix(src, []byte("\n")), []byte("\n"))
	return []decl.Symbol{{Kind: "file", Path: path, Line: 1, End: end, Body: decl.Hash(src)}}
}

// Index lists every file's symbols under dir (outside .git and node_modules) with each read resolved to the
// "path#name" of a top-level symbol in the tree; reads that name nothing in the tree are dropped.
// lazy: holds the whole tree's symbols in memory; stream per package past repos of ~1M symbols.
func Index(dir string) ([]decl.Symbol, error) {
	var all []decl.Symbol
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if !d.Type().IsRegular() {
			return nil
		}
		src, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		all = append(all, File(filepath.ToSlash(rel), src)...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	top := map[string]bool{}   // "path#name" of every top-level symbol
	pkg := map[string]string{} // Go names resolve by package (directory): "dir#Name" -> "path#Name"
	for _, s := range all {
		if s.Scope == "" && s.Name != "" {
			top[s.Path+"#"+s.Name] = true
			if strings.HasSuffix(s.Path, ".go") {
				pkg[path.Dir(s.Path)+"#"+s.Name] = s.Path + "#" + s.Name
			}
		}
	}
	for i, s := range all {
		var reads []string
		for _, r := range s.Reads {
			if t := resolve(s.Path, r, top, pkg); t != "" && !slices.Contains(reads, t) {
				reads = append(reads, t)
			}
		}
		all[i].Reads = reads
	}
	return all, nil
}

// ByPath lists a path's symbols in all.
func ByPath(all []decl.Symbol) func(path string) []decl.Symbol {
	m := map[string][]decl.Symbol{}
	for _, s := range all {
		m[s.Path] = append(m[s.Path], s)
	}
	return func(path string) []decl.Symbol { return m[path] }
}

// resolve maps read r of a symbol in file from to "path#name", or "" when r names nothing in the tree.
func resolve(from, r string, top map[string]bool, pkg map[string]string) string {
	mod, name, imported := strings.Cut(r, "#")
	if !imported {
		mod, name = "", r
	}
	if strings.HasSuffix(from, ".go") {
		if !imported {
			return pkg[path.Dir(from)+"#"+name]
		}
		// An import path ends with the package's directory in the repo: try each suffix.
		for p := mod; ; {
			if t := pkg[p+"#"+name]; t != "" {
				return t
			}
			i := strings.IndexByte(p, '/')
			if i < 0 {
				return ""
			}
			p = p[i+1:]
		}
	}
	if !imported {
		mod = path.Base(from)
	} else if !strings.HasPrefix(mod, ".") {
		return "" // a package, not a file in the tree
	}
	base := path.Join(path.Dir(from), mod)
	for _, f := range []string{base, base + ".js", base + ".jsx", base + ".ts", base + ".tsx", base + "/index.js", base + "/index.ts"} {
		if top[f+"#"+name] {
			return f + "#" + name
		}
	}
	return ""
}

// Write is a symbol ("path#name", or "path" for a file's top level) a diff changed. Kind is "signature" when its
// signature hash differs from the old tree's, or it was added or removed; "body" otherwise.
type Write struct {
	Symbol string `json:"symbol"`
	Kind   string `json:"kind"`
	// Lines: the base line ranges its hunks replaced ("12-13,7-6"; an insertion after line a is "a+1-a"). Two writes
	// of one symbol conflict only when their ranges overlap or touch, as in git's three-way merge.
	Lines string `json:"lines,omitempty"`
}

// Changes is what a diff writes and the symbols its added lines read.
type Changes struct {
	Writes []Write  `json:"writes"`
	Reads  []string `json:"reads"`
}

var ident = regexp.MustCompile(`[A-Za-z_$][\w$]*`)

// Diff maps diff (git diff -U0 --no-renames) onto the symbols it writes and reads. before and after list a path's
// symbols in the old and new trees; after's reads are resolved (Index). A read is a resolved read of a written
// symbol whose name appears on one of its added lines.
func Diff(diff string, before, after func(path string) []decl.Symbol) (Changes, error) {
	touched, added, _, err := walk(diff, after)
	if err != nil {
		return Changes{}, err
	}
	find := func(list []decl.Symbol, n string) *decl.Symbol {
		for i := range list {
			if name(list[i]) == n {
				return &list[i]
			}
		}
		return nil
	}
	ch := Changes{Writes: []Write{}, Reads: []string{}}
	var paths []string
	for _, t := range touched {
		if !slices.Contains(paths, t.Path) {
			paths = append(paths, t.Path)
		}
		old, cur := find(before(t.Path), t.Name), find(after(t.Path), t.Name)
		kind := "body"
		if t.New || t.Name != "" && (old == nil || cur == nil || old.Sig != cur.Sig) {
			kind = "signature"
		}
		w := t.Path
		if t.Name != "" {
			w += "#" + t.Name
		}
		ch.Writes = append(ch.Writes, Write{Symbol: w, Kind: kind})
		if cur == nil {
			continue
		}
		words := map[string]bool{}
		for n, text := range added[t.Path] {
			if cur.Line <= n && n <= cur.End {
				for _, w := range ident.FindAllString(text, -1) {
					words[w] = true
				}
			}
		}
		for _, r := range cur.Reads {
			if words[r[strings.LastIndexAny(r, "#.")+1:]] && !slices.Contains(ch.Reads, r) {
				ch.Reads = append(ch.Reads, r)
			}
		}
	}
	// A symbol gone from a touched path (or a deleted file) is a signature write.
	for _, p := range paths {
		now := map[string]bool{}
		for _, s := range after(p) {
			now[name(s)] = true
		}
		for _, s := range before(p) {
			if n := name(s); n != "" && !now[n] {
				ch.Writes = append(ch.Writes, Write{Symbol: p + "#" + n, Kind: "signature"})
			}
		}
	}
	return ch, nil
}

// Push maps diff (git diff -U0 --no-renames, base to the pushed head) of the checkout at dir onto the symbols it
// touched, the writes those are, and the reads: the other symbols declared in the files it wrote.
// lazy: reads are the written files' other declarations, not references; use Diff where the old tree is at hand.
func Push(dir, diff string) ([]Touch, []Write, []string, error) {
	declared := map[string][]decl.Symbol{}
	touched, _, ranges, err := walk(diff, func(path string) []decl.Symbol {
		src, err := os.ReadFile(filepath.Join(dir, path))
		if err != nil {
			return nil
		}
		s := File(path, src)
		declared[path] = s
		return s
	})
	if err != nil {
		return nil, nil, nil, err
	}
	writes := make([]Write, 0, len(touched))
	written := map[string]bool{}
	for _, t := range touched {
		w := Write{Symbol: t.Path, Kind: "body", Lines: strings.Join(ranges[[2]string{t.Path, t.Name}], ",")}
		if t.Name != "" {
			w.Symbol += "#" + t.Name
		}
		if t.New || t.Signature {
			w.Kind = "signature"
		}
		writes = append(writes, w)
		written[w.Symbol] = true
	}
	reads := []string{}
	for _, t := range touched {
		for _, s := range declared[t.Path] {
			if r := t.Path + "#" + name(s); !written[r] {
				written[r] = true
				reads = append(reads, r)
			}
		}
		delete(declared, t.Path)
	}
	return touched, writes, reads, nil
}
