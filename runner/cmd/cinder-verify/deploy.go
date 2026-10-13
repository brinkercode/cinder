package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// target is a deploy step's aws:, gcp:, azure: or ssh: map, as the flow designer saves it (TARGET_CONFIG in the
// contract). Its only credential is a Keystore secret: secret (key_secret for ssh), else the federated token below.
type target struct {
	RoleARN                                                                  string `json:"role_arn"`
	KeySecret                                                                string `json:"key_secret"`
	Provider, Region, Subscription, Host, User, Command, Secret, Fingerprint string
}

// federated is the Keystore secret holding the OIDC token a target without secret signs in with: for aws and gcp
// the token itself, for azure a {clientId, tenantId, token} JSON.
var federated = map[string]string{"aws": "AWS_WEB_IDENTITY_TOKEN", "gcp": "GCP_WEB_IDENTITY_TOKEN", "azure": "AZURE_FEDERATED_CREDENTIAL"}

// target returns step s's target kind and map, "" when it sets none.
func (s flowStep) target() (string, target) {
	switch {
	case s.AWS != nil:
		return "aws", *s.AWS
	case s.GCP != nil:
		return "gcp", *s.GCP
	case s.Azure != nil:
		return "azure", *s.Azure
	case s.SSH != nil:
		return "ssh", *s.SSH
	}
	return "", target{}
}

// credential is the Keystore secret step s's target reads, "" when it has no target.
func (s flowStep) credential() string {
	kind, t := s.target()
	if kind == "ssh" {
		return t.KeySecret
	}
	if t.Secret != "" {
		return t.Secret
	}
	return federated[kind]
}

// envValue is the value of name in env (NAME=value entries), "" when it isn't there.
func envValue(env []string, name string) string {
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, name+"="); ok {
			return v
		}
	}
	return ""
}

// needCLI is the script line that fails the step with a clear message when cli isn't on the worker's PATH.
func needCLI(cli string) string {
	return "command -v " + cli + ` >/dev/null || { echo "` + cli + ` CLI not found on this worker's PATH: install it to run this deploy step" >&2; exit 127; }`
}

// targetScript is the shell script that deploys step s to its target, the env it adds and the values to mask. The
// credential, in env (stepSecrets), goes to files in dir. A cloud target signs in from its fields and runs s.Run; ssh
// runs the target's command on a host whose key matches the saved fingerprint.
func targetScript(ctx context.Context, s flowStep, env []string, dir string) (script string, extra, hidden []string, err error) {
	kind, t := s.target()
	cred, file := envValue(env, s.credential()), filepath.Join(dir, "credentials")
	if kind != "ssh" && s.Run == "" {
		return "", nil, nil, errors.New("deploy to " + kind + ": set the step's run command, run after signing in")
	}
	var cli string
	switch kind {
	case "aws":
		cli, script = "aws", s.Run
		extra = []string{"AWS_REGION=" + t.Region, "AWS_DEFAULT_REGION=" + t.Region}
		if t.RoleARN != "" {
			// The CLI assumes the role with the token file itself (AssumeRoleWithWebIdentity).
			extra = append(extra, "AWS_ROLE_ARN="+t.RoleARN, "AWS_WEB_IDENTITY_TOKEN_FILE="+file, "AWS_ROLE_SESSION_NAME=cinder-deploy")
		} else {
			extra = append(extra, "AWS_SHARED_CREDENTIALS_FILE="+file)
		}
	case "gcp":
		cli, script = "gcloud", s.Run
		if t.Provider != "" {
			token := filepath.Join(dir, "token")
			if err := os.WriteFile(token, []byte(cred), 0o600); err != nil {
				return "", nil, nil, err
			}
			b, _ := json.Marshal(map[string]any{"type": "external_account", "audience": "//iam.googleapis.com/" + t.Provider,
				"subject_token_type": "urn:ietf:params:oauth:token-type:jwt", "token_url": "https://sts.googleapis.com/v1/token",
				"credential_source": map[string]string{"file": token}})
			cred = string(b)
		}
		extra = []string{"CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=" + file, "CLOUDSDK_CONFIG=" + filepath.Join(dir, "gcloud"),
			"CLOUDSDK_COMPUTE_REGION=" + t.Region, "CLOUDSDK_RUN_REGION=" + t.Region, "CLOUDSDK_FUNCTIONS_REGION=" + t.Region}
	case "azure":
		var sp struct{ ClientID, ClientSecret, TenantID, Token string }
		_ = json.Unmarshal([]byte(cred), &sp) // a bad JSON leaves the fields empty, refused below
		pass, login, field := sp.ClientSecret, `-p "$AZ_PASSWORD"`, "clientSecret"
		if t.Secret == "" {
			pass, login, field = sp.Token, `--federated-token "$AZ_PASSWORD"`, "token"
		}
		if sp.ClientID == "" || sp.TenantID == "" || pass == "" {
			return "", nil, nil, errors.New(s.credential() + ": not a {clientId, tenantId, " + field + "} JSON")
		}
		cli, hidden, cred = "az", []string{pass}, ""
		script = `az login --service-principal -u "$AZ_CLIENT_ID" ` + login + ` --tenant "$AZ_TENANT_ID" -o none || exit 1` + "\n" +
			`az account set -s "$AZ_SUBSCRIPTION" || exit 1` + "\n" + s.Run
		extra = []string{"AZURE_CONFIG_DIR=" + filepath.Join(dir, "az"), "AZ_CLIENT_ID=" + sp.ClientID, "AZ_PASSWORD=" + pass,
			"AZ_TENANT_ID=" + sp.TenantID, "AZ_SUBSCRIPTION=" + t.Subscription}
	case "ssh":
		known, err := pinnedHostKeys(ctx, t.Host, t.Fingerprint)
		if err != nil {
			return "", nil, nil, err
		}
		hosts := filepath.Join(dir, "known_hosts")
		if err := os.WriteFile(hosts, []byte(known), 0o600); err != nil {
			return "", nil, nil, err
		}
		// ssh refuses a key file without its final newline.
		cli, cred = "ssh", strings.TrimRight(cred, "\n")+"\n"
		script = `ssh -i "$DEPLOY_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$DEPLOY_KNOWN_HOSTS" -- "$DEPLOY_USER@$DEPLOY_HOST" "$DEPLOY_COMMAND"`
		extra = []string{"DEPLOY_KEY=" + file, "DEPLOY_KNOWN_HOSTS=" + hosts, "DEPLOY_USER=" + t.User, "DEPLOY_HOST=" + t.Host, "DEPLOY_COMMAND=" + t.Command}
	}
	if cred != "" {
		if err := os.WriteFile(file, []byte(cred), 0o600); err != nil {
			return "", nil, nil, err
		}
	}
	return needCLI(cli) + "\n" + script, extra, hidden, nil
}

// pinnedHostKeys is host's keys, as known_hosts lines, whose SHA256 fingerprint is fingerprint; none is an error.
func pinnedHostKeys(ctx context.Context, host, fingerprint string) (string, error) {
	out, scanErr := exec.CommandContext(ctx, "ssh-keyscan", "--", host).Output()
	var known strings.Builder
	for line := range strings.Lines(string(out)) {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		blob, err := base64.StdEncoding.DecodeString(f[2])
		if err != nil {
			continue
		}
		sum := sha256.Sum256(blob)
		if "SHA256:"+base64.RawStdEncoding.EncodeToString(sum[:]) == fingerprint {
			known.WriteString(line)
		}
	}
	if known.Len() == 0 {
		if scanErr != nil {
			return "", fmt.Errorf("ssh-keyscan %s: %w", host, scanErr)
		}
		return "", fmt.Errorf("host key of %s does not match the saved fingerprint %s: refusing to connect", host, fingerprint)
	}
	return known.String(), nil
}
