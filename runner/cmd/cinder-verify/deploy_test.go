package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// fakeBin puts executables name → script first on PATH.
func fakeBin(t *testing.T, scripts map[string]string) {
	t.Helper()
	bin := t.TempDir()
	for name, script := range scripts {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestDeploy_AWSTarget_AssumesRoleFromStepFields(t *testing.T) {
	fakeBin(t, map[string]string{"aws": `echo "aws $* role=$AWS_ROLE_ARN region=$AWS_REGION"
grep -qx web-identity-token-from-keystore "$AWS_WEB_IDENTITY_TOKEN_FILE" && echo token from keystore
`})
	report, calls := runRunJob(t, []map[string]any{{"name": "ship", "deploy": "production", "target": "AWS", "run": "aws sts get-caller-identity",
		"aws": map[string]any{"role_arn": "arn:aws:iam::1:role/deploy", "region": "eu-west-1", "service": "lambda", "resource": "fn"}}},
		fakeRun{secrets: map[string]string{"AWS_WEB_IDENTITY_TOKEN": "web-identity-token-from-keystore"}})
	if report.Status != "done" {
		t.Fatalf("report = %+v, want done", report)
	}
	got := texts(calls, 0)
	if !slices.Contains(got, "aws sts get-caller-identity role=arn:aws:iam::1:role/deploy region=eu-west-1") {
		t.Errorf("log = %q, want aws run with the step's role ARN and region", got)
	}
	if !slices.Contains(got, "token from keystore") {
		t.Errorf("log = %q, want the Keystore token as the web identity token file", got)
	}
	if strings.Contains(strings.Join(got, "\n"), "web-identity-token-from-keystore") {
		t.Errorf("log = %q, leaks the token", got)
	}
}

func TestDeploy_SSHTarget_RefusesAHostKeyThatDoesNotMatchTheFingerprint(t *testing.T) {
	fakeBin(t, map[string]string{
		"ssh-keyscan": "echo 'web1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'\n",
		"ssh":         "echo ssh ran\n",
	})
	report, calls := runRunJob(t, []map[string]any{{"name": "ship", "deploy": "production", "target": "Bring your own (SSH)",
		"ssh": map[string]any{"host": "web1.example.com", "user": "deploy", "command": "systemctl restart app", "fingerprint": "SHA256:not-this-host", "key_secret": "SSH_KEY"}}},
		fakeRun{secrets: map[string]string{"SSH_KEY": "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----"}})
	if report.Status != "failed" {
		t.Fatalf("report = %+v, want failed", report)
	}
	got := texts(calls, 0)
	if !slices.Contains(got, "host key of web1.example.com does not match the saved fingerprint SHA256:not-this-host: refusing to connect") {
		t.Errorf("log = %q, want the host key refused", got)
	}
	if slices.Contains(got, "ssh ran") {
		t.Errorf("log = %q, ssh connected to a host whose key does not match", got)
	}
}

func TestDeploy_MissingCredential_FailsNamingIt(t *testing.T) {
	report, calls := runRunJob(t, []map[string]any{{"name": "ship", "deploy": "production", "target": "AWS", "run": "true",
		"aws": map[string]any{"secret": "AWS_DEPLOY_KEY", "region": "eu-west-1", "service": "lambda", "resource": "fn"}}}, fakeRun{})
	if report.Status != "failed" {
		t.Fatalf("report = %+v, want failed", report)
	}
	if got := texts(calls, 0); !slices.Contains(got, "missing secret AWS_DEPLOY_KEY: save it in Keystore") {
		t.Errorf("log = %q, want the missing credential named", got)
	}
	if !slices.Equal(statuses(calls), []string{"1 running", "1 passed", "3 running", "3 passed", "0 running", "0 failed", "2 running", "2 passed"}) {
		t.Errorf("statuses = %v", statuses(calls))
	}
}
