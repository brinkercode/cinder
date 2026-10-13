package gitauth

import (
	"context"
	"slices"
	"testing"
)

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
