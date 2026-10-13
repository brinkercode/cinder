#!/usr/bin/env bash
# Run by runner/internal/install/install_test.go. Runs deploy/install.sh against a stubbed curl (a fake Cloudflare API), npx (wrangler) and cloudflare-up.sh.
set -euo pipefail
src=$(cd "$(dirname "$0")" && pwd)/install.sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/deploy" "$tmp/bin" "$tmp/state" "$tmp/conf"
cp "$src" "$tmp/repo/deploy/install.sh"
cat > "$tmp/repo/deploy/cloudflare-up.sh" <<'SH'
#!/usr/bin/env bash
printf 'CINDER_URL=https://cinder.x.workers.dev\nCINDER_TOKEN=t\n' > "$CINDER_CONF/live.env"; chmod 600 "$CINDER_CONF/live.env"
SH
printf '#!/bin/sh\ncat >/dev/null\n' > "$tmp/bin/npx"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
method=GET data=
while [ $# -gt 0 ]; do
  case $1 in -X) method=$2; shift ;; --data) data=$2; shift ;; https://*) path=${1#https://api.cloudflare.com/client/v4} ;; esac
  shift
done
echo "$method $path" >> "$STATE/calls"
list() { [ -s "$STATE/$1" ] && cat "$STATE/$1" || echo '[]'; }
add() { list "$1" | jq -c --argjson x "$2" '. + [$x]' > "$STATE/$1.new" && mv "$STATE/$1.new" "$STATE/$1"; }
case "$method $path" in
  "GET /accounts") echo '{"success":true,"result":[{"id":"acct1"}]}' ;;
  "GET /accounts/acct1/access/organizations") if [ -n "${NO_ORG:-}" ] && [ ! -e "$STATE/org" ]; then echo '{"success":false}'; else echo '{"success":true,"result":{"auth_domain":"team.cloudflareaccess.com"}}'; fi ;;
  "POST /accounts/acct1/access/organizations") echo "$data" > "$STATE/org"; echo '{"success":true,"result":{}}' ;;
  "GET /accounts/acct1/access/service_tokens") [ -z "${NO_ST_PERM:-}" ] || { echo '{"success":false}'; exit 0; }; jq -c '{success: true, result: .}' <<<"$(list tokens)" ;;
  "POST /accounts/acct1/access/service_tokens") add tokens '{"id":"tok1","name":"cinder-runners"}'
    echo '{"success":true,"result":{"id":"tok1","name":"cinder-runners","client_id":"cid.access","client_secret":"csecret"}}' ;;
  "GET /accounts/acct1/access/apps") jq -c '{success: true, result: .}' <<<"$(list apps)" ;;
  "POST /accounts/acct1/access/apps") app=$(jq -c '. + {id: "app1", aud: "aud1"}' <<<"$data"); add apps "$app"; echo "{\"success\":true,\"result\":$app}" ;;
  "GET /accounts/acct1/access/apps/app1/policies") jq -c '{success: true, result: .}' <<<"$(list policies)" ;;
  "POST /accounts/acct1/access/apps/app1/policies") add policies "$data"; echo '{"success":true,"result":{}}' ;;
  *) echo '{"success":false}' ;;
esac
SH
# a signed-in gh: records each secret name it is given, never the value
printf '#!/bin/sh\n[ "$1 $2" = "secret set" ] && { cat >/dev/null; echo "$3" >> "$STATE/gh"; }\nexit 0\n' > "$tmp/bin/gh"
chmod +x "$tmp/bin/"* "$tmp/repo/deploy/"*.sh
printf 'CLOUDFLARE_API_TOKEN=tok\n' > "$tmp/conf/cloudflare.env"
run() { PATH="$tmp/bin:$PATH" STATE="$tmp/state" CINDER_CONF="$tmp/conf" OWNERS=me@x.com "$tmp/repo/deploy/install.sh" >/dev/null; }
fail() { echo "FAIL: $*"; exit 1; }

case ${1:-} in
second-run) # a second run creates no new app, policy or service token
  run; run
  creates=$(grep -c '^POST' "$tmp/state/calls" || true)
  [ "$creates" = 3 ] || fail "expected 3 creates over two runs, got $creates: $(cat "$tmp/state/calls")"
  [ "$(jq length "$tmp/state/policies")" = 1 ] || fail "expected one runners policy"
  grep -qx 'CINDER_ACCESS_CLIENT_ID=cid.access' "$tmp/conf/live.env" || fail "live.env has no client id"
  grep -qx 'CINDER_ACCESS_CLIENT_SECRET=csecret' "$tmp/conf/live.env" || fail "live.env has no client secret"
  [ "$(stat -c %a "$tmp/conf/live.env")" = 600 ] || fail "live.env is not 0600" ;;
access-off) # CINDER_ACCESS=0 makes no Access API calls
  run
  grep -q /access/ "$tmp/state/calls" || fail "a default run made no Access API calls"
  : > "$tmp/state/calls"
  CINDER_ACCESS=0 run
  ! grep -q /access/ "$tmp/state/calls" || fail "Access API called: $(cat "$tmp/state/calls")" ;;
token-link) # the token link pre-fills every permission group
  rm "$tmp/conf/cloudflare.env"
  out=$(echo tok | PATH="$tmp/bin:$PATH" STATE="$tmp/state" CINDER_CONF="$tmp/conf" OWNERS=me@x.com "$tmp/repo/deploy/install.sh")
  for k in ai_gateway vectorize secrets_store artifacts containers access_acct; do grep -q "$k" <<<"$out" || fail "token link lacks $k: $out"; done ;;
no-org) # with no Zero Trust organization, install creates one named after the account
  NO_ORG=1 run
  [ "$(jq -r .auth_domain "$tmp/state/org")" = cinder-acct1.cloudflareaccess.com ] || fail "org not created: $(cat "$tmp/state/org" 2>&1)" ;;
release-secrets) # with CINDER_GH_SECRETS=1, the release's secrets are set
  CINDER_GH_SECRETS=1 run
  for n in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CINDER_OWNER_TOKEN CINDER_ACCESS_CLIENT_ID CINDER_ACCESS_CLIENT_SECRET; do
    grep -qx "$n" "$tmp/state/gh" || fail "$n not set: $(cat "$tmp/state/gh" 2>&1)"; done ;;
no-gh-secrets) # by default nothing is sent to GitHub, even with gh signed in
  run
  [ ! -s "$tmp/state/gh" ] || fail "secrets set without CINDER_GH_SECRETS=1: $(cat "$tmp/state/gh")" ;;
no-service-token-perm) # with the service-tokens probe failing, nothing is created
  ! NO_ST_PERM=1 run || fail "install succeeded without the service-tokens permission"
  ! grep -q '^POST' "$tmp/state/calls" || fail "created something: $(cat "$tmp/state/calls")"
  [ ! -e "$tmp/conf/live.env" ] || fail "deployed before the probe" ;;
*) fail "usage: $0 second-run|access-off|token-link|no-org|release-secrets|no-gh-secrets|no-service-token-perm" ;;
esac
