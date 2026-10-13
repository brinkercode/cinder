package guard

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// MaxFileSize is the largest file a push may add or change.
const MaxFileSize = 5 << 20

// ScanPush scans each commit a push adds to the git repo at dir: rev-list before..after, or for a new ref
// (all-zero before) after --not target. Each commit's added lines are scanned for secrets, and its binary files
// (Rule "binary") and files over MaxFileSize (Rule "oversize") are flagged, so a secret removed by a later commit
// is still found. A push whose before is not an ancestor of after is a force push: Rule "guard.force_push" with
// Path "before..after".
func ScanPush(ctx context.Context, dir, before, after, target string) ([]Finding, error) {
	git := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("guard: git %s: %w: %s", args[0], err, stderr.String())
		}
		return string(out), nil
	}
	// A deleted ref adds nothing.
	if strings.Trim(after, "0") == "" {
		return nil, nil
	}
	var out []Finding
	revs := []string{"rev-list", "--reverse", "--parents", after}
	if strings.Trim(before, "0") != "" {
		revs = append(revs, "^"+before)
		// is-ancestor answers with its exit code: 1 means not an ancestor, anything else non-zero is an error.
		if _, err := git("merge-base", "--is-ancestor", before, after); err != nil {
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				return nil, err
			}
			out = append(out, Finding{Rule: "guard.force_push", Path: before + ".." + after})
		}
	} else if target != "" {
		revs = append(revs, "--not", target)
	}
	list, err := git(revs...)
	if err != nil {
		return nil, err
	}
	// lazy: one diff per commit; a push of thousands of commits runs thousands of git processes.
	for _, l := range strings.Split(strings.TrimSpace(list), "\n") {
		ids := strings.Fields(l)
		if len(ids) == 0 {
			continue
		}
		// A root commit is diffed against the empty tree, hashed here since its id depends on the object format.
		if len(ids) == 1 {
			tree, err := git("hash-object", "-t", "tree", "/dev/null")
			if err != nil {
				return nil, err
			}
			ids = append(ids, strings.TrimSpace(tree))
		}
		found, err := scanCommit(git, ids[1], ids[0])
		if err != nil {
			return nil, err
		}
		out = append(out, found...)
	}
	return out, nil
}

// scanCommit scans the diff before..after (a commit against its first parent).
func scanCommit(git func(...string) (string, error), before, after string) ([]Finding, error) {
	var out []Finding
	diffArgs := []string{"diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", before, after, "--"}
	// -z: "added\tdeleted\tpath\x00"; git prints "-" counts for a binary file.
	stat, err := git("diff", "--numstat", "-z", "--no-renames", "--diff-filter=d", before, after)
	if err != nil {
		return nil, err
	}
	// lazy: one git process per changed file for its size; batch with cat-file --batch-check past ~1k files.
	for _, rec := range strings.Split(strings.TrimSuffix(stat, "\x00"), "\x00") {
		f := strings.SplitN(rec, "\t", 3)
		if len(f) != 3 {
			continue
		}
		if f[0] == "-" {
			out = append(out, Finding{Rule: "binary", Path: f[2]})
		}
		size, err := git("cat-file", "-s", after+":"+f[2])
		if err != nil {
			return nil, err
		}
		n, err := strconv.Atoi(strings.TrimSpace(size))
		if err != nil {
			return nil, fmt.Errorf("guard: size of %s: %w", f[2], err)
		}
		if n > MaxFileSize {
			out = append(out, Finding{Rule: "oversize", Path: f[2]})
			// Already blocked; skipping its lines saves the regex time and the scanner's line limit.
			diffArgs = append(diffArgs, ":(exclude,literal)"+f[2])
		}
	}
	diff, err := git(diffArgs...)
	if err != nil {
		return nil, err
	}
	var path string
	line, adds := 0, 0
	sc := bufio.NewScanner(strings.NewReader(diff))
	sc.Buffer(nil, 1<<24)
	for sc.Scan() {
		l := sc.Text()
		switch {
		// adds counts the hunk's remaining added lines, so an added "++ x" line isn't read as a header.
		case adds > 0 && strings.HasPrefix(l, "+"):
			for _, s := range Scan(path, l[1:]) {
				s.Line = line
				out = append(out, s)
			}
			line++
			adds--
		case strings.HasPrefix(l, "+++ "):
			path = strings.TrimPrefix(l[4:], "b/")
		case strings.HasPrefix(l, "@@ "):
			// "@@ -a,b +c[,d] @@": d added lines start at c; an omitted d means 1.
			if _, err := fmt.Sscanf(strings.Fields(l)[2], "+%d,%d", &line, &adds); err != nil {
				adds = 1
			}
		}
	}
	return out, sc.Err()
}
