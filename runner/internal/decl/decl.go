// Package decl splits source files into top-level declarations for structured merge.
package decl

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
)

// Decl is one top-level declaration. Text is src[Start:End] and includes the
// text before it back to the previous declaration; the last Decl runs to EOF,
// so joining every Text reproduces the source.
type Decl struct {
	Key        string
	Start, End int
	Text       string

	// Set by SplitJS only; lines are 1-based.
	Kind               string
	StartLine, EndLine int
}

// SplitGo splits Go source into the package clause and one Decl per ast.Decl.
// Keys are kind:name, methods kind:Recv.Name; init and _ get ordinal suffixes.
func SplitGo(src []byte) ([]Decl, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "", src, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	off := func(p token.Pos) int { return fset.Position(p).Offset }
	ends := []int{off(f.Name.End())}
	keys := []string{"package:" + f.Name.Name}
	seen := map[string]int{}
	for _, d := range f.Decls {
		key := declKey(d)
		if key == "func:init" || key[len(key)-2:] == ":_" {
			seen[key]++
			key = fmt.Sprintf("%s#%d", key, seen[key])
		}
		keys = append(keys, key)
		ends = append(ends, off(d.End()))
	}
	ends[len(ends)-1] = len(src)
	out := make([]Decl, len(keys))
	start := 0
	for i, k := range keys {
		out[i] = Decl{Key: k, Start: start, End: ends[i], Text: string(src[start:ends[i]])}
		start = ends[i]
	}
	return out, nil
}

func declKey(d ast.Decl) string {
	switch d := d.(type) {
	case *ast.FuncDecl:
		if d.Recv != nil && len(d.Recv.List) > 0 {
			return "func:" + recvName(d.Recv.List[0].Type) + "." + d.Name.Name
		}
		return "func:" + d.Name.Name
	case *ast.GenDecl:
		kind := d.Tok.String()
		if len(d.Specs) == 0 {
			return kind + ":()"
		}
		switch s := d.Specs[0].(type) {
		case *ast.ImportSpec:
			return kind + ":" + s.Path.Value
		case *ast.TypeSpec:
			return kind + ":" + s.Name.Name
		case *ast.ValueSpec:
			return kind + ":" + s.Names[0].Name
		}
	}
	return "bad:"
}

func recvName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvName(t.X)
	case *ast.ParenExpr:
		return recvName(t.X)
	case *ast.IndexExpr:
		return recvName(t.X)
	case *ast.IndexListExpr:
		return recvName(t.X)
	case *ast.Ident:
		return t.Name
	}
	return "?"
}
