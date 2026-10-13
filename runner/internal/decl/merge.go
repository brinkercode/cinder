package decl

import (
	"errors"
	"fmt"
	"go/format"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Merge three-way merges one file of lang ("go" or "js"). It keeps git's line
// merge when that is clean, and otherwise merges by declaration. When ok is
// false conflicts remain and out is git's line-merge result with markers.
func Merge(base, ours, theirs []byte, lang string) (out []byte, ok bool, err error) {
	line, ok, err := lineMerge(base, ours, theirs)
	if err != nil || ok {
		return line, ok, err
	}
	split := map[string]func([]byte) ([]Decl, error){"go": SplitGo, "js": SplitJS}[lang]
	if split == nil {
		return line, false, nil
	}
	var v [3][]Decl
	for i, src := range [][]byte{base, ours, theirs} {
		if v[i], err = split(src); err != nil {
			return line, false, nil
		}
	}
	// Anchors are keyed by position, so matching them is only safe when one side left them alone.
	if anchors(v[1]) != anchors(v[0]) && anchors(v[2]) != anchors(v[0]) {
		return line, false, nil
	}
	text, keys, ok, err := merge3(v[0], v[1], v[2])
	if err != nil || !ok {
		return line, false, err
	}
	// Safety: every kept declaration exactly once, and the result still parses.
	re, err := split([]byte(text))
	if err != nil || len(re) != len(keys) {
		return line, false, nil
	}
	count := map[string]int{}
	for _, d := range re {
		count[d.Key]++
	}
	for _, k := range keys {
		if count[k] != 1 {
			return line, false, nil
		}
	}
	if lang == "go" {
		formatted, err := format.Source([]byte(text))
		if err != nil {
			return line, false, nil
		}
		return formatted, true, nil
	}
	return []byte(text), true, nil
}

func anchors(ds []Decl) string {
	var b strings.Builder
	for _, d := range ds {
		if strings.HasPrefix(d.Key, "anchor:") {
			b.WriteString(d.Text)
		}
	}
	return b.String()
}

// merge3 merges by key and returns the text and the kept keys in output order.
// Imports changed on both sides merge line by line as a set.
func merge3(base, ours, theirs []Decl) (string, []string, bool, error) {
	b, o, t := byKey(base), byKey(ours), byKey(theirs)
	take := map[string]string{}
	for _, side := range [][]Decl{base, ours, theirs} {
		for _, d := range side {
			k := d.Key
			bt, inB := b[k]
			ot, inO := o[k]
			tt, inT := t[k]
			switch {
			case inO && inT && ot == tt:
				take[k] = ot
			case inO && inT && inB && ot == bt:
				take[k] = tt
			case inO && inT && inB && tt == bt:
				take[k] = ot
			case inO && inT && inB:
				var s string
				var ok bool
				var err error
				if strings.HasPrefix(k, "import:") {
					s, _, ok, err = merge3(lines(bt), lines(ot), lines(tt))
				} else {
					var out []byte
					out, ok, err = lineMerge([]byte(bt), []byte(ot), []byte(tt))
					s = string(out)
				}
				if err != nil || !ok {
					return "", nil, false, err
				}
				take[k] = s
			case inO && inT: // added on both sides, differently
				return "", nil, false, nil
			case inO && !inB:
				take[k] = ot
			case inT && !inB:
				take[k] = tt
			case inO && ot != bt, inT && tt != bt: // deleted on one side, modified on the other
				return "", nil, false, nil
			}
		}
	}
	// Their additions go after the nearest earlier declaration ours also has.
	after := map[string][]string{}
	prev := ""
	for _, d := range theirs {
		if _, inO := o[d.Key]; inO {
			prev = d.Key
		} else if _, kept := take[d.Key]; kept {
			after[prev] = append(after[prev], d.Key)
		}
	}
	keys := after[""]
	for _, d := range ours {
		if _, kept := take[d.Key]; kept {
			keys = append(keys, d.Key)
		}
		keys = append(keys, after[d.Key]...)
		delete(after, d.Key) // a repeated line key must not repeat its additions
	}
	var text strings.Builder
	for _, k := range keys {
		text.WriteString(take[k])
	}
	return text.String(), keys, true, nil
}

func byKey(ds []Decl) map[string]string {
	m := make(map[string]string, len(ds))
	for _, d := range ds {
		m[d.Key] = d.Text
	}
	return m
}

// lines makes one Decl per line, keyed by its text.
func lines(s string) []Decl {
	var ds []Decl
	for _, l := range strings.SplitAfter(s, "\n") {
		if l != "" { // SplitAfter ends with "" and "" is merge3's start-of-file key
			ds = append(ds, Decl{Key: l, Text: l})
		}
	}
	return ds
}

// lineMerge runs git merge-file --diff3; ok is false when it left conflicts.
func lineMerge(base, ours, theirs []byte) (out []byte, ok bool, err error) {
	dir, err := os.MkdirTemp("", "cinder-merge")
	if err != nil {
		return nil, false, err
	}
	defer os.RemoveAll(dir)
	args := []string{"merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs"}
	for i, src := range [][]byte{ours, base, theirs} {
		p := filepath.Join(dir, strconv.Itoa(i))
		if err := os.WriteFile(p, src, 0o600); err != nil {
			return nil, false, err
		}
		args = append(args, p)
	}
	out, err = exec.Command("git", args...).Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() > 0 && exit.ExitCode() < 128 {
		return out, false, nil // the exit code counts conflicts
	}
	return out, err == nil, err
}

// relock regenerates the lockfile next to every manifest that differs between $1 and $2
// ($2 empty: the working tree): a merge driver sees only one file, and git writes the
// merged package.json/go.mod after all drivers ran. npm and go run with an allowlisted
// environment: a repo's .npmrc or go config must not read the runner token or git's auth header.
const relock = `clean() { env -i PATH="$PATH" HOME="$HOME" ${GOPATH:+"GOPATH=$GOPATH"} ${GOCACHE:+"GOCACHE=$GOCACHE"} ${GOMODCACHE:+"GOMODCACHE=$GOMODCACHE"} ${npm_config_cache:+"npm_config_cache=$npm_config_cache"} "$@"; }
git diff --name-only $1 $2 -- '*package.json' '*go.mod' '*go.sum' | while read -r f; do
	d=$(dirname "$f")
	case "$f" in
	*package.json) [ ! -f "$d/package-lock.json" ] || (cd "$d" && clean npm install --package-lock-only --ignore-scripts --no-audit --no-fund) ;;
	*) (cd "$d" && clean go mod tidy) ;;
	esac
done
`

// Relock regenerates lockfiles in the clone at dir for manifests the working tree changed
// since HEAD, for a merge that stopped on conflicts (post-merge doesn't run then).
func Relock(dir string) error {
	cmd := exec.Command("sh", "-ec", relock, "relock", "HEAD")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("relock: %w: %s", err, out)
	}
	return nil
}

// postMerge regenerates lockfiles and renumbers colliding migrations after a clean merge.
const postMerge = "#!/bin/sh\nset -- ORIG_HEAD HEAD\n" + relock + `# A numbered migration ours added whose number theirs also added is renumbered after theirs.
git rev-parse -q --verify HEAD^2 >/dev/null || exit 0
git diff --name-only --diff-filter=A HEAD^2...ORIG_HEAD | grep -E '(^|/)migrations/[0-9]+_[^/]*$' | while read -r f; do
	d=$(dirname "$f") b=$(basename "$f")
	n=${b%%_*}
	git diff --name-only --diff-filter=A ORIG_HEAD HEAD -- "$d/${n}_*" | grep -q . || continue
	max=$(ls "$d" | sed -n 's/^\([0-9][0-9]*\)_.*/\1/p' | sort -n | tail -n 1)
	git mv "$f" "$d/$(printf "%0${#n}d" "$(expr "$max" + 1)")_${b#*_}"
done
`

// InstallDriver makes git in the clone at dir merge *.go, *.js and *.jsx with
// "bin merge-driver", keep ours for package-lock.json, union go.sum and CHANGELOG.md,
// regenerate lockfiles and renumber colliding migrations after a merge. All of it lives in .git, so the repo's files are untouched.
func InstallDriver(dir, bin string) error {
	for k, v := range map[string]string{"merge.cinder.driver": bin + " merge-driver %O %A %B %P", "merge.cinder-ours.driver": "true"} {
		if out, err := exec.Command("git", "-C", dir, "config", k, v).CombinedOutput(); err != nil {
			return fmt.Errorf("git config: %w: %s", err, out)
		}
	}
	gitPath := func(p string) (string, error) {
		out, err := exec.Command("git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-path", p).Output()
		if err != nil {
			return "", fmt.Errorf("git rev-parse: %w", err)
		}
		p = strings.TrimSpace(string(out))
		return p, os.MkdirAll(filepath.Dir(p), 0o755)
	}
	attrs, err := gitPath("info/attributes")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(attrs, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = f.WriteString("*.go merge=cinder\n*.js merge=cinder\n*.jsx merge=cinder\npackage-lock.json merge=cinder-ours\ngo.sum merge=union\nCHANGELOG.md merge=union\n")
	if err := errors.Join(err, f.Close()); err != nil {
		return err
	}
	hook, err := gitPath("hooks/post-merge")
	if err != nil {
		return err
	}
	// O_EXCL: never replace a hook someone else installed.
	f, err = os.OpenFile(hook, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, err = f.WriteString(postMerge)
	return errors.Join(err, f.Close())
}
