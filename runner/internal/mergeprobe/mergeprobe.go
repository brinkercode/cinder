// Package mergeprobe dry-runs a merge with git merge-tree, so a conflict becomes data
// without touching any branch or worktree.
package mergeprobe

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// File is one conflicted path. Markers counts its conflict regions in the merged result;
// a blob is empty when that side has no version of the path (add/add, modify/delete).
type File struct {
	Path       string `json:"file"`
	Markers    int    `json:"markers"`
	OursBlob   string `json:"ours_blob,omitempty"`
	TheirsBlob string `json:"theirs_blob,omitempty"`
	BaseBlob   string `json:"base_blob,omitempty"`
}

// Result is a merge-tree outcome. Clean is true only on exit 0.
type Result struct {
	Clean bool
	Files []File
}

// Probe merges theirs into ours in repoDir in memory. An empty base lets git pick the merge base.
func Probe(repoDir, base, ours, theirs string) (Result, error) {
	args := []string{"-C", repoDir, "merge-tree", "--write-tree", "-z"}
	if base != "" {
		args = append(args, "--merge-base="+base)
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("git", append(args, ours, theirs)...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return Result{Clean: true}, nil
	case !errors.As(err, &exit) || exit.ExitCode() != 1 || strings.Contains(stderr.String(), "fatal:"):
		return Result{}, fmt.Errorf("git merge-tree: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	// -z output: <tree> NUL, then "<mode> <oid> <stage>\t<path>" NUL per conflicted stage, then an empty entry.
	entries := strings.Split(stdout.String(), "\x00")
	tree := entries[0]
	var files []File
	for _, e := range entries[1:] {
		if e == "" {
			break
		}
		meta, path, ok := strings.Cut(e, "\t")
		f := strings.Fields(meta)
		if !ok || len(f) != 3 {
			return Result{}, fmt.Errorf("git merge-tree: unexpected conflict entry %q", e)
		}
		if len(files) == 0 || files[len(files)-1].Path != path {
			files = append(files, File{Path: path})
		}
		cur := &files[len(files)-1]
		switch f[2] {
		case "1":
			cur.BaseBlob = f[1]
		case "2":
			cur.OursBlob = f[1]
		case "3":
			cur.TheirsBlob = f[1]
		}
	}
	if tree == "" || len(files) == 0 {
		return Result{}, fmt.Errorf("git merge-tree: exit 1 without conflicted files: %q", stdout.String())
	}
	for i := range files {
		out, err := exec.Command("git", "-C", repoDir, "cat-file", "blob", tree+":"+files[i].Path).Output()
		if err != nil {
			return Result{}, fmt.Errorf("git cat-file %s: %w", files[i].Path, err)
		}
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "<<<<<<< ") {
				files[i].Markers++
			}
		}
	}
	return Result{Files: files}, nil
}
