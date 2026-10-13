package decl

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func keys(t *testing.T, src string) []string {
	t.Helper()
	ds, err := SplitGo([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	var ks []string
	for _, d := range ds {
		ks = append(ks, d.Key)
	}
	return ks
}

func TestSplitGoRoundTrip(t *testing.T) {
	n := 0
	err := filepath.WalkDir("../..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		ds, err := SplitGo(src)
		if err != nil {
			t.Errorf("%s: %v", path, err)
			return nil
		}
		var b strings.Builder
		for _, d := range ds {
			if d.Text != string(src[d.Start:d.End]) {
				t.Errorf("%s %s: Text does not match range", path, d.Key)
			}
			b.WriteString(d.Text)
		}
		if b.String() != string(src) {
			t.Errorf("%s: joined pieces differ from source", path)
		}
		n++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n < 10 {
		t.Fatalf("only %d .go files found", n)
	}
}

func TestSplitGoMethodKey(t *testing.T) {
	got := strings.Join(keys(t, "package p\n\ntype A struct{}\ntype B[T any] struct{}\n\nfunc (A) Run() {}\n\n// doc\nfunc (b *B[T]) Run() {}\nfunc Run() {}\n"), " ")
	want := "package:p type:A type:B func:A.Run func:B.Run func:Run"
	if got != want {
		t.Fatalf("keys = %q, want %q", got, want)
	}
}

func TestSplitGoInitNotUnique(t *testing.T) {
	got := strings.Join(keys(t, "package p\n\nfunc init() {}\n\nvar _ = 1\n\nfunc init() {}\nfunc init() {}\n"), " ")
	want := "package:p func:init#1 var:_#1 func:init#2 func:init#3"
	if got != want {
		t.Fatalf("keys = %q, want %q", got, want)
	}
}
