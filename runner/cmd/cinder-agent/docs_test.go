package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestReadme_NamesMakeUp_EveryMakeTargetExists(t *testing.T) {
	readme, err := os.ReadFile("../../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	makefile, err := os.ReadFile("../../../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(readme), "make up") {
		t.Error("README doesn't name make up")
	}
	for _, m := range regexp.MustCompile(`\bmake ([a-z][a-z0-9-]*)`).FindAllStringSubmatch(string(readme), -1) {
		if !regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(m[1]) + `:`).Match(makefile) {
			t.Errorf("README names make %s, Makefile has no such target", m[1])
		}
	}
}

func TestDesign_StackSection_ListsCloudflareProducts(t *testing.T) {
	design, err := os.ReadFile("../../../docs/DESIGN.md")
	if err != nil {
		t.Fatal(err)
	}
	s := string(design)
	start := strings.Index(s, "## 8. Stack")
	end := strings.Index(s, "## 9.")
	if start < 0 || end < start {
		t.Fatal("DESIGN.md has no §8 Stack section")
	}
	for _, p := range []string{"Containers", "Workflows", "R2", "AI Gateway", "Secrets Store", "Vectorize"} {
		if !strings.Contains(s[start:end], p) {
			t.Errorf("DESIGN.md §8 doesn't list %s", p)
		}
	}
}

func TestDesign_NoPromoteKeyOrPromoteKind(t *testing.T) {
	design, err := os.ReadFile("../../../docs/DESIGN.md")
	if err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`(?i)promot`).Match(design) {
		t.Error("DESIGN.md still describes a promote key or a promote change kind")
	}
}
