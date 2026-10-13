package owners

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Line is who wrote one line of a file: the commit that brought it onto the branch and, when that commit is a
// merged change's, its Cinder-Change and Cinder-Agent trailers (see cinder-agent's merge); otherwise its author.
type Line struct {
	Commit string `json:"commit"`
	Change string `json:"change,omitempty"`
	Agent  string `json:"agent,omitempty"`
	Person string `json:"person,omitempty"`
}

// Blame returns one Line per line of path at ref in the repo in dir.
func Blame(ctx context.Context, dir, ref, path string) ([]Line, error) {
	git := func(args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
		if err != nil {
			return "", fmt.Errorf("git %s: %w", args[0], err)
		}
		return string(out), nil
	}
	// --first-parent blames a line from a merged change on its merge commit, which carries the trailers.
	out, err := git("blame", "--first-parent", "--line-porcelain", ref, "--", path)
	if err != nil {
		return nil, err
	}
	lines, authors, sha, header := []Line{}, map[string]string{}, "", true
	for l := range strings.Lines(out) {
		switch {
		case header:
			sha, _, _ = strings.Cut(l, " ")
			header = false
		case strings.HasPrefix(l, "\t"):
			lines = append(lines, Line{Commit: sha})
			header = true
		case strings.HasPrefix(l, "author "):
			authors[sha] = strings.TrimSpace(l[len("author "):])
		}
	}
	if len(lines) == 0 {
		return lines, nil
	}
	shas := make([]string, 0, len(authors))
	for s := range authors {
		shas = append(shas, s)
	}
	out, err = git(append([]string{"log", "--no-walk=unsorted",
		"--format=%H%x09%(trailers:key=Cinder-Change,valueonly,separator=%x2C)%x09%(trailers:key=Cinder-Agent,valueonly,separator=%x2C)"}, shas...)...)
	if err != nil {
		return nil, err
	}
	trailers := map[string][]string{}
	for l := range strings.Lines(out) {
		if f := strings.Split(strings.TrimRight(l, "\n"), "\t"); len(f) == 3 {
			trailers[f[0]] = f[1:]
		}
	}
	for i := range lines {
		t := trailers[lines[i].Commit]
		if len(t) == 2 {
			lines[i].Change, lines[i].Agent = strings.TrimSpace(t[0]), strings.TrimSpace(t[1])
		}
		if lines[i].Agent == "" {
			lines[i].Person = authors[lines[i].Commit]
		}
	}
	return lines, nil
}
