package gitauth

import (
	"context"
	"slices"
	"testing"
)

func TestCommand_Clone_AddsBlobFilter(t *testing.T) {
	t.Setenv("CINDER_URL", "http://cinder.internal")
	for _, args := range [][]string{
		{"clone", "--branch", "main", "--", "remote", "dir"},
		// cinder-agent's helpers put -C and -c before the subcommand.
		{"-C", "dir", "-c", "user.name=cinder-agent", "clone", "--quiet", "remote", "."},
	} {
		got := Command(context.Background(), "", args...).Args[1:]
		i := slices.Index(args, "clone") + 1
		want := slices.Concat(args[:i], []string{"--filter=blob:none"}, args[i:])
		if !slices.Equal(got, want) {
			t.Errorf("args = %q, want %q", got, want)
		}
	}
}

func TestCommand_MirrorClone_StaysFull(t *testing.T) {
	t.Setenv("CINDER_URL", "http://cinder.internal")
	args := []string{"clone", "--quiet", "--mirror", "--", "fork", "dir"}
	if got := Command(context.Background(), "", args...).Args[1:]; !slices.Equal(got, args) {
		t.Errorf("args = %q, want %q unchanged: the secret scan reads every blob", got, args)
	}
}

func TestCommand_ByoRunnerClone_StaysFull(t *testing.T) {
	// A BYO runner reaches cinder's public URL: no egress gives its later git reads a token.
	t.Setenv("CINDER_URL", "https://cinder.example.workers.dev")
	args := []string{"clone", "--branch", "main", "--", "remote", "dir"}
	if got := Command(context.Background(), "", args...).Args[1:]; !slices.Equal(got, args) {
		t.Errorf("args = %q, want %q unchanged", got, args)
	}
}

func TestCommand_NotClone_ArgsUnchanged(t *testing.T) {
	args := []string{"-C", "dir", "fetch", "--", "clone"}
	if got := Command(context.Background(), "", args...).Args[1:]; !slices.Equal(got, args) {
		t.Errorf("args = %q, want %q unchanged", got, args)
	}
}

func TestCommand_RefreshedToken_SendsLatest(t *testing.T) {
	Refresh("claimed", "fresh")
	if !slices.Contains(Command(context.Background(), "claimed", "status").Env, "GIT_CONFIG_VALUE_0=Authorization: Bearer fresh") {
		t.Error("a refreshed token: want the heartbeat's token in the header")
	}
	Refresh("claimed", "")
	if !slices.Contains(Command(context.Background(), "claimed", "status").Env, "GIT_CONFIG_VALUE_0=Authorization: Bearer claimed") {
		t.Error("a forgotten token: want the claim's token back")
	}
}
