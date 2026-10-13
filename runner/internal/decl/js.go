package decl

import (
	"bytes"
	"fmt"
	"strings"
)

type tok struct {
	start, end, depth int
	kind              byte // i identifier or number, s string/template/regex, j JSX, p punct
}

type lexer struct {
	src     []byte
	i       int
	toks    []tok
	regexOK bool // the previous token ends where an expression may start
}

// After these words an expression starts (so / is a regex) and the statement
// continues onto the next line.
const exprWords = " return typeof instanceof in new delete void throw case do else yield await export default extends import const let var function class "

// These continue the statement only in import/export position; elsewhere they
// may be identifiers, so `from / 2` divides.
const moduleWords = " from as "

// A line starting with one of these continues the previous statement.
const contWords = " from as in instanceof of extends else catch finally "

var closer = map[byte]byte{'(': ')', '[': ']', '{': '}'}

// SplitJS splits JS/JSX source into top-level declarations. Statements other
// than import, export, function, class and const/let/var become ordered
// anchors keyed "anchor:N". Unbalanced input returns an error.
func SplitJS(src []byte) ([]Decl, error) {
	l := &lexer{src: src, regexOK: true}
	if err := l.scan(0, 0); err != nil {
		return nil, err
	}
	// lazy: a statement starts after a top-level ';' or on a new line unless a
	// few ASI rules say it continues; not the full grammar. Its leading text
	// starts after the previous statement's line, even inside a /* comment.
	var starts, gaps []int
	prev := -1
	for k, t := range l.toks {
		if t.depth != 0 {
			continue
		}
		if prev < 0 {
			starts, gaps = append(starts, k), append(gaps, 0)
		} else {
			end, pk, pt := l.toks[prev].end, l.toks[prev].kind, " "+l.text(prev)+" "
			gap := end + 1 + bytes.IndexByte(src[end:t.start], '\n')
			startsLine := gap > end && (t.kind == 's' || t.kind == 'i' && !strings.Contains(contWords, " "+l.text(k)+" "))
			continues := pk == 'p' && !strings.Contains(" ) ] } ++ -- ", pt) || pk == 'i' && (strings.Contains(exprWords, pt) ||
				strings.Contains(moduleWords, pt) && strings.Contains(" import export ", " "+l.text(starts[len(starts)-1])+" "))
			if pt == " ; " || startsLine && !continues {
				starts, gaps = append(starts, k), append(gaps, gap)
			}
		}
		prev = k
	}
	if len(starts) == 0 && len(src) > 0 {
		return []Decl{{Kind: "anchor", Key: "anchor:0", End: len(src), Text: string(src), StartLine: 1, EndLine: 1 + bytes.Count(src, []byte("\n"))}}, nil
	}
	var decls []Decl
	anchors := 0
	for n, s := range starts {
		stop := len(l.toks)
		d := Decl{Start: gaps[n], End: len(src)}
		if n+1 < len(starts) {
			stop, d.End = starts[n+1], gaps[n+1]
		}
		d.Kind, d.Key = l.key(s, stop)
		if d.Kind == "anchor" {
			d.Key = fmt.Sprintf("anchor:%d", anchors)
			anchors++
		}
		last := stop - 1
		for l.toks[last].depth != 0 {
			last--
		}
		d.StartLine = 1 + bytes.Count(src[:d.Start], []byte("\n"))
		d.EndLine = 1 + bytes.Count(src[:l.toks[last].end], []byte("\n"))
		d.Text = string(src[d.Start:d.End])
		decls = append(decls, d)
	}
	return decls, nil
}

func (l *lexer) text(k int) string { return string(l.src[l.toks[k].start:l.toks[k].end]) }

// key names the statement in toks[s:stop].
func (l *lexer) key(s, stop int) (string, string) {
	next := ""
	if s+1 < stop {
		next = l.text(s + 1)
	}
	switch l.text(s) {
	case "import": // bare import './x', import() and import.meta stay anchors
		if p := l.first(s, stop, 's'); p != "" && l.toks[s+1].kind != 's' && next != "(" && next != "." {
			return "import", "import:" + p
		}
	case "export", "async":
		switch {
		case next == "default":
			return "export", "export:default"
		case next == "*" || next == "{":
			if p := l.first(s, stop, 's'); p != "" {
				return "export", "export:" + p
			}
			return "export", "export:" + l.first(s+1, stop, 'i')
		case next != "":
			return l.key(s+1, stop)
		}
	case "function":
		return "func", "func:" + l.first(s, stop, 'i')
	case "class":
		return "class", "class:" + l.first(s, stop, 'i')
	case "const", "let", "var":
		return "var", "var:" + l.first(s, stop, 'i')
	case "interface": // TypeScript
		return "interface", "interface:" + next
	case "type": // TypeScript: type Name = ... or type Name<T> = ...
		if s+2 < stop && (l.text(s+2) == "=" || l.text(s+2) == "<") {
			return "type", "type:" + next
		}
	}
	return "anchor", ""
}

// first returns the first identifier, or top-level string, after toks[s].
func (l *lexer) first(s, stop int, kind byte) string {
	for k := s + 1; k < stop; k++ {
		if l.toks[k].kind == kind && (kind == 'i' || l.toks[k].depth == 0) {
			return strings.Trim(l.text(k), "'\"`")
		}
	}
	return ""
}

// scan reads tokens at depth until it consumes close (0 means end of input).
func (l *lexer) scan(depth int, close byte) error {
	for l.i < len(l.src) {
		c, rest := l.src[l.i], l.src[l.i:]
		if c <= ' ' {
			l.i++
			continue
		}
		if bytes.HasPrefix(rest, []byte("//")) {
			for l.i < len(l.src) && l.src[l.i] != '\n' {
				l.i++
			}
			continue
		}
		if bytes.HasPrefix(rest, []byte("/*")) {
			n := bytes.Index(rest[2:], []byte("*/"))
			if n < 0 {
				return fmt.Errorf("unterminated comment at %d", l.i)
			}
			l.i += n + 4
			continue
		}
		n := len(l.toks)
		l.toks = append(l.toks, tok{start: l.i, depth: depth, kind: 'p'})
		var err error
		ok := false // regexOK after this token
		switch {
		case c == ')' || c == ']' || c == '}':
			if c != close {
				return fmt.Errorf("unbalanced: unexpected %q at %d", c, l.i)
			}
			l.i++
			l.toks[n].end, l.toks[n].depth = l.i, depth-1
			return nil
		case c == '"' || c == '\'' || c == '`' || c == '/' && l.regexOK:
			l.toks[n].kind = 's'
			err = l.literal(c, depth)
		case c == '<' && l.regexOK && l.i+1 < len(l.src) && (isIdent(l.src[l.i+1]) || l.src[l.i+1] == '>'):
			l.toks[n].kind = 'j'
			err = l.jsx(depth)
		case isIdent(c):
			l.toks[n].kind = 'i'
			for l.i < len(l.src) && isIdent(l.src[l.i]) {
				l.i++
			}
			ok = strings.Contains(exprWords, " "+string(l.src[l.toks[n].start:l.i])+" ")
		case (c == '+' || c == '-') && l.i+1 < len(l.src) && l.src[l.i+1] == c:
			l.i += 2
		default:
			l.i++
			ok = true
		}
		if err != nil {
			return err
		}
		l.toks[n].end, l.regexOK = l.i, ok
		if closer[c] != 0 {
			l.regexOK = true
			if err := l.scan(depth+1, closer[c]); err != nil {
				return err
			}
			l.regexOK = false
		}
	}
	if close != 0 {
		return fmt.Errorf("unbalanced: missing %q at end of input", close)
	}
	return nil
}

func isIdent(c byte) bool {
	return c == '_' || c == '$' || c == '#' || c >= 0x80 ||
		c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// literal reads a string, regex or template (with ${} expressions) from its
// opening quote q.
func (l *lexer) literal(q byte, depth int) error {
	class := false // inside a regex [...]
	for l.i++; l.i < len(l.src) && (q == '`' || l.src[l.i] != '\n'); l.i++ {
		switch c := l.src[l.i]; {
		case c == '\\':
			l.i++
		case q == '/' && (c == '[' || c == ']'):
			class = c == '['
		case c == q && !class:
			for l.i++; q == '/' && l.i < len(l.src) && isIdent(l.src[l.i]); l.i++ {
			}
			return nil
		case q == '`' && bytes.HasPrefix(l.src[l.i:], []byte("${")):
			l.i, l.regexOK = l.i+2, true
			if err := l.scan(depth+1, '}'); err != nil {
				return err
			}
			l.i, l.toks = l.i-1, l.toks[:len(l.toks)-1] // drop the closing }: it is part of this literal
		}
	}
	return fmt.Errorf("unterminated %c literal at %d", q, l.i)
}

// jsx reads one element from its '<'. Text inside JSX is not JS, so quotes
// there mean nothing; only tags and {} expressions matter.
func (l *lexer) jsx(depth int) error {
	open, inTag := 0, false
	for ; l.i < len(l.src); l.i++ {
		rest := l.src[l.i:]
		closing := bytes.HasPrefix(rest, []byte("</"))
		switch {
		case inTag && rest[0] == '>':
			inTag = false
		case inTag && bytes.HasPrefix(rest, []byte("/>")), !inTag && closing:
			n := bytes.IndexByte(rest, '>')
			if n < 0 {
				return fmt.Errorf("unterminated JSX tag at %d", l.i)
			}
			l.i += n
			open, inTag = open-1, false
			if open == 0 {
				l.i++
				return nil
			}
		case !inTag && rest[0] == '<':
			open, inTag = open+1, true
		case inTag && (rest[0] == '"' || rest[0] == '\''):
			n := bytes.IndexByte(rest[1:], rest[0])
			if n < 0 {
				return fmt.Errorf("unterminated JSX attribute at %d", l.i)
			}
			l.i += n + 1
		case rest[0] == '{':
			l.i, l.regexOK = l.i+1, true
			if err := l.scan(depth+1, '}'); err != nil {
				return err
			}
			l.i, l.toks = l.i-1, l.toks[:len(l.toks)-1] // drop the closing }: it is part of this literal
		}
	}
	return fmt.Errorf("unterminated JSX element at %d", l.i)
}
