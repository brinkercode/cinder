package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/brinkercode/cinder/runner/internal/api"
	"github.com/brinkercode/cinder/runner/internal/decl"
	"github.com/brinkercode/cinder/runner/internal/gitauth"
	"github.com/brinkercode/cinder/runner/internal/owners"
	"github.com/brinkercode/cinder/runner/internal/symbols"
)

// runResult runs an index, blame or compare job on a clone of the claim's remote and PUTs what it found to the
// runner route of payload.repo; the job's report then says done.
func runResult(ctx context.Context, client *api.Client, c *api.Claim) api.Report {
	var p struct{ Repo, Sha, Path, Base, Head string }
	if err := json.Unmarshal(c.Payload, &p); err != nil || p.Repo == "" {
		return api.Report{Status: "failed", Detail: "cinder-verify: " + c.Job.Kind + " payload needs repo"}
	}
	dir, err := os.MkdirTemp("", "cinder-"+c.Job.Kind+"-")
	if err != nil {
		return api.Report{Status: "failed", Detail: err.Error()}
	}
	defer os.RemoveAll(dir)
	if out, err := gitauth.Command(ctx, string(c.ReadToken), "clone", "-q", "--no-checkout", "--", c.TargetRemote, dir).CombinedOutput(); err != nil {
		return api.Report{Status: "failed", Detail: fmt.Sprintf("git clone: %v\n%s", err, out)}
	}
	route := "/api/work/repos/" + url.PathEscape(p.Repo)
	var body any
	switch c.Job.Kind {
	case "index":
		route += "/symbols/" + url.PathEscape(p.Sha)
		body, err = index(ctx, dir, p.Sha)
	case "blame":
		route += "/authorship/" + url.PathEscape(p.Sha) + "?path=" + url.QueryEscape(p.Path)
		body, err = owners.Blame(ctx, dir, p.Sha, p.Path)
	default:
		route += "/compare/" + url.PathEscape(p.Base) + "/" + url.PathEscape(p.Head)
		body, err = compare(ctx, dir, p.Base, p.Head)
	}
	if err == nil {
		err = client.Put(ctx, route, body)
	}
	if err != nil {
		return api.Report{Status: "failed", Detail: "cinder-verify " + c.Job.Kind + ": " + err.Error()}
	}
	return api.Report{Status: "done"}
}

// index checks out sha in dir and lists its symbols, as `cinder-verify symbols` prints them.
func index(ctx context.Context, dir, sha string) ([]decl.Symbol, error) {
	if out, err := exec.CommandContext(ctx, "git", "-C", dir, "checkout", "-q", "--detach", sha).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("git checkout: %v\n%s", err, out)
	}
	return symbols.Index(dir)
}

type compareCommit struct {
	Sha     string `json:"sha"`
	Message string `json:"message"`
}

type compareFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Patch     string `json:"patch"`
}

// compare is head against base: commits ahead and behind, head's commits since base and the files changed since
// their merge base, each with its line counts and patch hunks.
func compare(ctx context.Context, dir, base, head string) (any, error) {
	git := func(args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir, "-c", "core.quotePath=false"}, args...)...).Output()
		if err != nil {
			return "", fmt.Errorf("git %s: %w", args[0], err)
		}
		return string(out), nil
	}
	span := base + "..." + head
	out, err := git("rev-list", "--left-right", "--count", span)
	if err != nil {
		return nil, err
	}
	var behind, ahead int
	if _, err := fmt.Sscan(out, &behind, &ahead); err != nil {
		return nil, err
	}
	if out, err = git("log", "--format=%H%x09%s", base+".."+head); err != nil {
		return nil, err
	}
	commits := []compareCommit{}
	for l := range strings.Lines(out) {
		sha, msg, _ := strings.Cut(strings.TrimRight(l, "\n"), "\t")
		commits = append(commits, compareCommit{sha, msg})
	}
	if out, err = git("diff", "--no-renames", "--numstat", span); err != nil {
		return nil, err
	}
	files := []compareFile{}
	for l := range strings.Lines(out) {
		f := strings.SplitN(strings.TrimRight(l, "\n"), "\t", 3)
		if len(f) != 3 {
			continue
		}
		// A binary file's counts are "-": 0 lines.
		adds, _ := strconv.Atoi(f[0])
		dels, _ := strconv.Atoi(f[1])
		// lazy: two git calls per file; parse one full diff if compares get wide.
		status, err := git("diff", "--no-renames", "--name-status", span, "--", f[2])
		if err != nil {
			return nil, err
		}
		patch, err := git("diff", "--no-renames", span, "--", f[2])
		if err != nil {
			return nil, err
		}
		if i := strings.Index(patch, "\n@@"); i >= 0 {
			patch = patch[i+1:]
		} else {
			patch = ""
		}
		word := "modified"
		if strings.HasPrefix(status, "A") {
			word = "added"
		} else if strings.HasPrefix(status, "D") {
			word = "deleted"
		}
		files = append(files, compareFile{f[2], word, adds, dels, patch})
	}
	return map[string]any{"ahead": ahead, "behind": behind, "commits": commits, "files": files}, nil
}
