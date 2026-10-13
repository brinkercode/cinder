package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
)

// A fresh clone of the published pulse repo holds exactly the files git tracks (or would track) under demo/pulse.
func TestPulse_CheckPassesOnFreshClone(t *testing.T) {
	src, err := filepath.Abs("../../../demo/pulse")
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("git", "-C", src, "ls-files", "-z", "--cached", "--others", "--exclude-standard").Output()
	if err != nil {
		t.Fatalf("git ls-files: %v", err)
	}
	dir := t.TempDir()
	for _, name := range bytes.Split(bytes.TrimRight(out, "\x00"), []byte{0}) {
		b, err := os.ReadFile(filepath.Join(src, string(name)))
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(dir, string(name))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifest, err := os.ReadFile(filepath.Join(dir, ".cinder.yml"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^check:\s*(.+)$`).FindSubmatch(manifest)
	if m == nil {
		t.Fatal(".cinder.yml has no check")
	}
	cmd := exec.Command("sh", "-c", string(m[1]))
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s: %v\n%s", m[1], err, out)
	}
}
