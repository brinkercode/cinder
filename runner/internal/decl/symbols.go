package decl

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"reflect"
	"regexp"
	"slices"
	"strings"
)

// Symbol is one tag, named with Universal Ctags' JSON fields so consumers of ctags output don't change.
type Symbol struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Path  string `json:"path"`
	Line  int    `json:"line"`
	End   int    `json:"end"`
	Scope string `json:"scope,omitempty"`
	// Exported marks a JS declaration that is exported; Go's export is its capitalised name.
	Exported bool `json:"exported,omitempty"`
	// Sig hashes the name and parameters and results (a type's whole shape); Body hashes the whole declaration.
	Sig  string `json:"sig,omitempty"`
	Body string `json:"body,omitempty"`
	// Reads are the names the declaration references: "Name" in its own package or file, "import#Name" from an
	// import (a Go import path or a JS module specifier).
	Reads []string `json:"reads,omitempty"`
}

// Hash is a short content hash for Sig and Body.
func Hash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

// SymbolsGo lists top-level declarations plus methods (scoped by receiver) and struct fields.
func SymbolsGo(path string, src []byte) ([]Symbol, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, src, 0)
	if err != nil {
		return nil, err
	}
	imports := map[string]string{} // local name -> import path
	for _, im := range f.Imports {
		p := strings.Trim(im.Path.Value, `"`)
		n := p[strings.LastIndexByte(p, '/')+1:]
		if im.Name != nil {
			n = im.Name.Name
		}
		imports[n] = p
	}
	hash := func(prefix string, n ast.Node) string {
		b := bytes.NewBufferString(prefix)
		if present(n) {
			_ = printer.Fprint(b, fset, n) // a parsed AST prints; only a writer error fails, and a buffer has none
		}
		return Hash(b.Bytes())
	}
	var out []Symbol
	add := func(n *ast.Ident, kind string, end token.Pos, scope, sig, body string, refs ...ast.Node) {
		out = append(out, Symbol{Name: n.Name, Kind: kind, Path: path, Line: fset.Position(n.Pos()).Line, End: fset.Position(end).Line,
			Scope: scope, Sig: sig, Body: body, Reads: goReads(imports, refs...)})
	}
	for _, d := range f.Decls {
		switch d := d.(type) {
		case *ast.FuncDecl:
			scope := ""
			if d.Recv != nil && len(d.Recv.List) > 0 {
				scope = recvName(d.Recv.List[0].Type)
			}
			sig := hash("", &ast.FuncDecl{Recv: d.Recv, Name: d.Name, Type: d.Type})
			add(d.Name, "func", d.End(), scope, sig, hash(sig, d.Body), d.Recv, d.Type, d.Body)
		case *ast.GenDecl:
			for _, s := range d.Specs {
				switch s := s.(type) {
				case *ast.TypeSpec:
					shape := hash("", s)
					st, ok := s.Type.(*ast.StructType)
					if !ok {
						add(s.Name, "type", s.End(), "", shape, shape, s.TypeParams, s.Type)
						continue
					}
					add(s.Name, "struct", s.End(), "", shape, shape, s.TypeParams, s.Type)
					for _, fl := range st.Fields.List {
						for _, n := range fl.Names {
							field := hash(n.Name+" ", fl.Type)
							add(n, "member", fl.End(), s.Name.Name, field, field, fl.Type)
						}
					}
				case *ast.ValueSpec:
					for _, n := range s.Names {
						add(n, d.Tok.String(), s.End(), "", hash(n.Name+" ", s.Type), hash("", s), s.Type, &ast.CompositeLit{Elts: s.Values})
					}
				}
			}
		}
	}
	return out, nil
}

// present is false for nil and for a nil pointer in the interface (a func without a body, a type without type params).
func present(n ast.Node) bool {
	return n != nil && !reflect.ValueOf(n).IsNil()
}

// goReads lists the identifiers under nodes ("Name") and the imported names they select ("import/path#Name").
// lazy: no type information, so x.Method() on a variable is not a read of the method; use go/types if leases need it.
func goReads(imports map[string]string, nodes ...ast.Node) []string {
	var out []string
	add := func(r string) {
		if !slices.Contains(out, r) {
			out = append(out, r)
		}
	}
	var visit func(ast.Node) bool
	visit = func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.SelectorExpr:
			if x, ok := n.X.(*ast.Ident); ok && imports[x.Name] != "" {
				add(imports[x.Name] + "#" + n.Sel.Name)
			} else {
				ast.Inspect(n.X, visit)
			}
			return false
		case *ast.Ident:
			add(n.Name)
		}
		return true
	}
	for _, n := range nodes {
		if present(n) {
			ast.Inspect(n, visit)
		}
	}
	return out
}

// SymbolsJS lists the functions, classes, variables and TypeScript types and interfaces SplitJS keys, plus class
// methods (depth 1 of the class body). A declaration is exported when it starts with export, is export default, or
// is named in a local export clause.
func SymbolsJS(path string, src []byte) ([]Symbol, error) {
	ds, err := SplitJS(src)
	if err != nil {
		return nil, err
	}
	l := &lexer{src: src, regexOK: true}
	_ = l.scan(0, 0) // SplitJS just scanned the same src without error
	line := func(off int) int { return 1 + bytes.Count(src[:off], []byte("\n")) }
	var out []Symbol
	clause := map[string]bool{}    // local names in export { a, b as c } clauses
	imports := map[string]string{} // local name -> "module#name" for import { name as local } from "module"
	k := 0
	for _, d := range ds {
		for k < len(l.toks) && l.toks[k].start < d.Start {
			k++
		}
		e := k
		for e < len(l.toks) && l.toks[e].start < d.End {
			e++
		}
		kind := map[string]string{"func": "function", "class": "class", "var": "variable", "type": "type", "interface": "interface"}[d.Kind]
		name := d.Key[strings.IndexByte(d.Key, ':')+1:]
		if d.Kind == "import" {
			for m := k; m < e; m++ {
				if l.toks[m].depth == 1 && l.toks[m].kind == 'i' && (l.text(m-1) == "{" || l.text(m-1) == ",") {
					local := l.text(m)
					if m+2 < e && l.text(m+1) == "as" {
						local = l.text(m + 2)
					}
					imports[local] = name + "#" + l.text(m)
				}
			}
		}
		if d.Key == "export:default" { // export default [async] function|class name
			j := k + 2
			if j < len(l.toks) && l.text(j) == "async" {
				j++
			}
			kind, name = "", ""
			if j+1 < len(l.toks) && l.toks[j+1].kind == 'i' {
				kind, name = map[string]string{"function": "function", "class": "class"}[l.text(j)], l.text(j+1)
			}
		}
		if d.Kind == "export" && d.Key != "export:default" && l.text(k+1) == "{" {
			from := false
			var names []string
			for m := k + 2; m < len(l.toks) && l.toks[m].start < d.End; m++ {
				from = from || l.toks[m].depth == 0 && l.text(m) == "from"
				if l.toks[m].depth == 1 && l.toks[m].kind == 'i' && (l.text(m-1) == "{" || l.text(m-1) == ",") {
					names = append(names, l.text(m))
				}
			}
			for _, n := range names {
				clause[n] = clause[n] || !from // export { x } from "m" names another module's x
			}
		}
		if kind == "" {
			continue
		}
		sig := e
		if kind != "type" && kind != "interface" {
			sig = l.sigEnd(k, e)
		}
		out = append(out, Symbol{Name: name, Kind: kind, Path: path, Line: line(l.toks[k].start), End: d.EndLine, Exported: l.text(k) == "export",
			Sig: Hash(l.join(k, sig)), Body: Hash(l.join(k, e)), Reads: l.reads(k, e, name)})
		if kind != "class" {
			continue
		}
		// lazy: a method is a depth-1 name before "(" that starts a member; a field
		// without a trailing ";" hides the method after it.
		for m := k + 1; m+1 < len(l.toks) && l.toks[m].start < d.End; m++ {
			if l.toks[m].depth != 1 || l.toks[m].kind != 'i' || l.text(m+1) != "(" {
				continue
			}
			if l.toks[m-1].depth == 1 && !strings.Contains(" } ; static async get set * ", " "+l.text(m-1)+" ") {
				continue
			}
			e := m + 1
			for e < len(l.toks)-1 && (l.toks[e].depth != 1 || l.text(e) != "}") {
				e++
			}
			out = append(out, Symbol{Name: l.text(m), Kind: "method", Path: path, Line: line(l.toks[m].start), End: line(l.toks[e].start), Scope: name,
				Sig: Hash(l.join(m, l.sigEnd(m, e))), Body: Hash(l.join(m, e+1)), Reads: l.reads(m, e+1, "")})
		}
	}
	for i, s := range out {
		out[i].Exported = s.Exported || s.Scope == "" && clause[s.Name]
		for j, r := range s.Reads {
			if imports[r] != "" {
				s.Reads[j] = imports[r]
			}
		}
	}
	return out, nil
}

// sigEnd is the token ending the signature in toks[k:e]: the body's "{" or "=>", or a variable's "=" unless a
// function follows it.
func (l *lexer) sigEnd(k, e int) int {
	for m := k + 1; m < e; m++ {
		if l.toks[m].depth != l.toks[k].depth {
			continue
		}
		if t := l.text(m); t == "{" || t == "=>" || t == "=" && (m+1 >= e || !strings.Contains(" ( async function ", " "+l.text(m+1)+" ")) {
			return m
		}
	}
	return e
}

// join is the text of toks[k:e], one space between tokens, so reformatting alone changes no hash.
func (l *lexer) join(k, e int) []byte {
	var b []byte
	for m := k; m < e; m++ {
		b = append(append(b, l.text(m)...), ' ')
	}
	return b
}

var jsxTag = regexp.MustCompile(`<([A-Z][\w$]*)`)

// reads lists the names toks[k:e] references other than self: identifiers not after "." and JSX component tags.
func (l *lexer) reads(k, e int, self string) []string {
	var out []string
	add := func(n string) {
		if n != self && !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	for m := k; m < e; m++ {
		switch {
		case l.toks[m].kind == 'i' && (m == 0 || l.text(m-1) != "."):
			add(l.text(m))
		case l.toks[m].kind == 'j':
			for _, t := range jsxTag.FindAllStringSubmatch(l.text(m), -1) {
				add(t[1])
			}
		}
	}
	return out
}
