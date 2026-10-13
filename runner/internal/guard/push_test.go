package guard

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// repo makes a fresh repo with an empty first commit. commit writes files, commits them and returns the new head.
func repo(t *testing.T) (dir string, git func(...string) string, commit func(map[string]string) string) {
	t.Helper()
	dir = t.TempDir()
	git = func(args ...string) string {
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	commit = func(files map[string]string) string {
		for name, content := range files {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		git("add", ".")
		git("commit", "--quiet", "-m", "push")
		return git("rev-parse", "HEAD")
	}
	git("init", "--quiet")
	git("commit", "--quiet", "--allow-empty", "-m", "base")
	return dir, git, commit
}

// push commits files on top of a fresh repo's first commit and returns dir, before and after.
func push(t *testing.T, files map[string]string) (string, string, string) {
	t.Helper()
	dir, git, commit := repo(t)
	before := git("rev-parse", "HEAD")
	return dir, before, commit(files)
}

func TestScanPush_AWSKey_Detected(t *testing.T) {
	dir, before, after := push(t, map[string]string{"config.env": "x=1\n++ AWS_ACCESS_KEY_ID=" + awsKey + "\n"})
	got, err := ScanPush(context.Background(), dir, before, after, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rule != "aws_access_key_id" || got[0].Path != "config.env" || got[0].Line != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestScanPush_BinaryFile_Flagged(t *testing.T) {
	dir, _, after := push(t, map[string]string{"blob.bin": "\x7fELF\x00\x01", "ok.txt": "hello\n"})
	got, err := ScanPush(context.Background(), dir, strings.Repeat("0", 40), after, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rule != "binary" || got[0].Path != "blob.bin" {
		t.Fatalf("got %+v", got)
	}
}

func TestScanPush_FileOver5MB_Flagged(t *testing.T) {
	dir, before, after := push(t, map[string]string{"big.txt": strings.Repeat("a", MaxFileSize+1), "small.txt": "a"})
	got, err := ScanPush(context.Background(), dir, before, after, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rule != "oversize" || got[0].Path != "big.txt" {
		t.Fatalf("got %+v", got)
	}
}

func TestGuard_SecretAddedThenRemoved_StillFound(t *testing.T) {
	dir, git, commit := repo(t)
	before := git("rev-parse", "HEAD")
	commit(map[string]string{"config.env": "AWS_ACCESS_KEY_ID=" + awsKey + "\n"})
	after := commit(map[string]string{"config.env": "AWS_ACCESS_KEY_ID=\n"})
	got, err := ScanPush(context.Background(), dir, before, after, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rule != "aws_access_key_id" || got[0].Path != "config.env" {
		t.Fatalf("got %+v", got)
	}
}

func TestGuard_ForcePush_Reported(t *testing.T) {
	dir, git, commit := repo(t)
	before := commit(map[string]string{"a.txt": "one\n"})
	git("reset", "--quiet", "--hard", "HEAD~1")
	after := commit(map[string]string{"a.txt": "two\n"})
	got, err := ScanPush(context.Background(), dir, before, after, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rule != "guard.force_push" || got[0].Path != before+".."+after {
		t.Fatalf("got %+v", got)
	}
}

func TestGuard_NewRef_ScansOnlyCommitsNotOnTarget(t *testing.T) {
	dir, git, commit := repo(t)
	target := commit(map[string]string{"old.env": awsKey + "\n"})
	git("checkout", "--quiet", "-b", "feature")
	after := commit(map[string]string{"new.go": anthropicKey + "\n"})
	got, err := ScanPush(context.Background(), dir, strings.Repeat("0", 40), after, target)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rule != "anthropic_api_key" || got[0].Path != "new.go" {
		t.Fatalf("got %+v", got)
	}
}

func TestScanPush_BidiOverrideInAddedLine_Found(t *testing.T) {
	dir, before, after := push(t, map[string]string{"auth.go": "package auth\nif role != \"user\u202e \u2066// admin\u2069 \u2066\" {\n"})
	got, err := ScanPush(context.Background(), dir, before, after, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 || got[0].Rule != "injection.bidi" || got[0].Path != "auth.go" || got[0].Line != 2 || got[0].Masked != `"\u202e"` {
		t.Fatalf("got %+v", got)
	}
}

func TestScanPush_TagCharsInReadme_Found(t *testing.T) {
	// "ignore" spelled in tag characters (U+E0000 + ASCII), invisible when rendered.
	var hidden strings.Builder
	for _, r := range "ignore" {
		hidden.WriteRune(0xE0000 + r)
	}
	dir, before, after := push(t, map[string]string{"README.md": "# Project\nWelcome." + hidden.String() + "\n"})
	got, err := ScanPush(context.Background(), dir, before, after, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rule != "injection.tag_chars" || got[0].Path != "README.md" || got[0].Line != 2 {
		t.Fatalf("got %+v", got)
	}
}
