// Package install tests deploy/install.sh (make up) through deploy/install_test.sh, which stubs curl and wrangler.
package install

import (
	"os/exec"
	"testing"
)

// run runs case name of deploy/<script>, which stubs curl and wrangler, and fails t with its output.
func run(t *testing.T, script, name string) {
	out, err := exec.Command("../../../deploy/"+script, name).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

func TestInstall_SecondRun_CreatesNoNewAppPolicyOrServiceToken(t *testing.T) {
	run(t, "install_test.sh", "second-run")
}

func TestInstall_AccessOff_MakesNoAccessAPICalls(t *testing.T) {
	run(t, "install_test.sh", "access-off")
}

func TestInstall_TokenLink_PrefillsEveryPermissionGroup(t *testing.T) {
	run(t, "install_test.sh", "token-link")
}

func TestInstall_NoZeroTrustOrg_CreatesIt(t *testing.T) {
	run(t, "install_test.sh", "no-org")
}

func TestInstall_GhSecretsOptIn_SetsReleaseSecrets(t *testing.T) {
	run(t, "install_test.sh", "release-secrets")
}

func TestInstall_Default_SendsNoSecretsToGitHub(t *testing.T) {
	run(t, "install_test.sh", "no-gh-secrets")
}

func TestInstall_ServiceTokenProbeFails_CreatesNoAccessAppOrPolicy(t *testing.T) {
	run(t, "install_test.sh", "no-service-token-perm")
}

func TestReconcile_MissingGatewayCreated_ExistingLeftUntouched(t *testing.T) {
	run(t, "reconcile_test.sh", "gateway")
}

func TestReconcile_MissingSecretsStore_Created_ExistingLeftUntouched(t *testing.T) {
	run(t, "reconcile_test.sh", "secrets-store")
}

func TestReconcile_GatewayAuthenticationOff_TurnedOn(t *testing.T) {
	run(t, "reconcile_test.sh", "gateway-auth")
}

func TestReconcile_MergeSigningSecret_CreatedOnceAndBoundWithResolvedStoreID(t *testing.T) {
	run(t, "reconcile_test.sh", "merge-signing")
}

func TestReconcile_CreateDenied_FailsNamingPermission(t *testing.T) {
	run(t, "reconcile_test.sh", "gateway-denied")
}

func TestReconcile_DeadLetterQueuesCreated(t *testing.T) {
	run(t, "reconcile_test.sh", "dlq")
}

func TestReconcile_MissingSecretsWorker_Deployed_ExistingLeftUntouched(t *testing.T) {
	run(t, "reconcile_test.sh", "secrets-worker")
}

func TestReconcile_AccountIDs_ReplaceCommittedOnes(t *testing.T) {
	run(t, "reconcile_test.sh", "d1-id")
}

func TestReconcile_MissingWorkerSecrets_PutOnceNeverOverwritten(t *testing.T) {
	run(t, "reconcile_test.sh", "worker-secrets")
}

func TestReconcile_LogsBucket_FlowsExpiryRuleSetOnce(t *testing.T) {
	run(t, "reconcile_test.sh", "logs-lifecycle")
}

func TestReconcile_AccessAppCookie_SetToLaxOnce(t *testing.T) {
	run(t, "reconcile_test.sh", "access-cookie")
}

func TestTeardown_EveryResourceKind_DeletedArtifactsFirstBucketsEmptiedFirst(t *testing.T) {
	run(t, "teardown_test.sh", "deletes-everything")
}

func TestTeardown_DryRun_ListsAndDeletesNothing(t *testing.T) {
	run(t, "teardown_test.sh", "dry-run")
}

func TestTeardown_SecondRun_SkipsEverythingAndSucceeds(t *testing.T) {
	run(t, "teardown_test.sh", "second-run")
}

func TestTeardown_WrongAccountId_DeletesNothing(t *testing.T) {
	run(t, "teardown_test.sh", "confirm")
}
