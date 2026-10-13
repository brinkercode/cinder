#!/usr/bin/env bash
# make up: installs cinder on your Cloudflare account and prints its URL.
# 1. auth: you approve a pre-filled API token in the Cloudflare dashboard and paste it once (stored 0600)
# 2. deploy: deploy/cloudflare-up.sh (D1, Queue, Artifacts check, secrets, migrations, Worker)
# 3. sign-in (creates the Zero Trust organization when there is none; skip with CINDER_ACCESS=0): a Cloudflare Access app in front of the Worker, allowing OWNERS and a runner service token
# 4. release secrets: set on your GitHub repo only with CINDER_GH_SECRETS=1
set -euo pipefail
cd "$(dirname "$0")/.."
conf=${CINDER_CONF:-$HOME/.config/cinder}
mkdir -p "$conf" && chmod 700 "$conf"
env_file="$conf/cloudflare.env"
# shellcheck disable=SC1090
if [ -r "$env_file" ]; then set -a; . "$env_file"; set +a; fi
api() { curl -sS "https://api.cloudflare.com/client/v4$1" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" -H "Content-Type: application/json" "${@:2}"; }
account() { api /accounts | jq -r 'select(.success) | .result[0].id // empty'; }

echo "== Cloudflare auth"
acct=$( [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && account || true)
if [ -z "$acct" ]; then
  # Documented template URL keys: developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
  # Keys beyond the documented ones (ai_gateway, vectorize, ...) follow the dashboard's snake_cased group names; a group the link
  # doesn't pre-fill is named by the first reconcile step that needs it, so it fails loudly rather than silently.
  perms='[{"key":"account_settings","type":"read"},{"key":"workers_scripts","type":"edit"},{"key":"workers_kv_storage","type":"edit"},{"key":"d1","type":"edit"},{"key":"queues","type":"edit"},{"key":"workers_r2","type":"edit"},{"key":"workers_ai","type":"read"},{"key":"ai_gateway","type":"edit"},{"key":"ai_gateway","type":"run"},{"key":"vectorize","type":"edit"},{"key":"containers","type":"edit"},{"key":"secrets_store","type":"edit"},{"key":"artifacts","type":"edit"},{"key":"access","type":"edit"},{"key":"access_service_tokens","type":"edit"},{"key":"access_acct","type":"edit"},{"key":"account_analytics","type":"read"}]'
  url="https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=$(jq -rn --arg p "$perms" '$p | @uri')&name=cinder"
  printf '\nOpen this link, create the token (every permission cinder needs is filled in) and paste it below:\n\n  %s\n\n' "$url"
  read -rsp "Paste the token (hidden): " CLOUDFLARE_API_TOKEN; echo
  acct=$(account)
  [ -n "$acct" ] || { echo "That token can't read your account (needs Account Settings: Read)."; exit 2; }
  umask 077
  # shellcheck disable=SC2016 # CF_DEPLOY_TOKEN follows the API token when the file is sourced
  printf 'CLOUDFLARE_API_TOKEN=%s\nCF_ACCOUNT_ID=%s\nCF_DEPLOY_TOKEN="$CLOUDFLARE_API_TOKEN"\n' "$CLOUDFLARE_API_TOKEN" "$acct" > "$env_file"
fi
echo "account $acct"
# Probe Access service tokens before deploying or creating anything, so a missing permission stops the install here.
# lazy: listing only proves Read; a Read-only token still fails later at creation, upgrade if that shows up.
if [ "${CINDER_ACCESS:-1}" != 0 ] && ! api "/accounts/$acct/access/service_tokens" | jq -e .success >/dev/null; then
  echo "The token can't use Access service tokens: edit it in the Cloudflare dashboard, add \"Access: Service Tokens: Edit\", then re-run."; exit 2
fi

deploy/cloudflare-up.sh
# shellcheck disable=SC1091
. "$conf/live.env"

if [ "${CINDER_ACCESS:-1}" != 0 ]; then
  echo; echo "== Cloudflare Access (sign-in)"
  team=$(api "/accounts/$acct/access/organizations" | jq -r '.result.auth_domain // empty')
  if [ -z "$team" ]; then
    team="cinder-${acct:0:8}.cloudflareaccess.com"
    api "/accounts/$acct/access/organizations" -X POST --data "$(jq -n --arg t "$team" '{name: "cinder", auth_domain: $t}')" | jq -e .success >/dev/null \
      || { echo "Creating the Zero Trust organization failed (token needs Access: Organizations, Identity Providers, and Groups Edit)."; exit 1; }
    echo "Zero Trust organization created: $team"
  fi
  host=${CINDER_URL#https://}
  owners=${OWNERS:-$(git config user.email)}
  # The service token's secret is only returned at creation, so it is kept in access.env and copied into live.env.
  creds="$conf/access.env"
  tok=$(api "/accounts/$acct/access/service_tokens" | jq -r '.result[]? | select(.name == "cinder-runners") | .id' | head -1)
  if [ -z "$tok" ]; then
    created=$(api "/accounts/$acct/access/service_tokens" -X POST --data '{"name":"cinder-runners"}' | jq -c 'select(.success) | .result')
    [ -n "$created" ] || { echo "Creating the Access service token failed (token needs Access: Service Tokens Edit)."; exit 1; }
    tok=$(jq -r .id <<<"$created")
    (umask 077; jq -r '"CINDER_ACCESS_CLIENT_ID=\(.client_id)\nCINDER_ACCESS_CLIENT_SECRET=\(.client_secret)"' <<<"$created" > "$creds")
  fi
  [ -s "$creds" ] || { echo "Service token cinder-runners exists but its secret isn't in $creds: delete it under Zero Trust → Access → Service auth, then re-run."; exit 2; }
  app=$(api "/accounts/$acct/access/apps" | jq -c --arg h "$host" '.result[]? | select(.domain == $h)' | head -1)
  if [ -z "$app" ]; then
    body=$(jq -n --arg h "$host" --arg o "$owners" '{name: "cinder", domain: $h, type: "self_hosted", session_duration: "24h",
      policies: [{name: "owners", decision: "allow", include: ($o | split(",") | map({email: {email: .}}))}]}')
    app=$(api "/accounts/$acct/access/apps" -X POST --data "$body" | jq -c 'select(.success) | .result')
    [ -n "$app" ] || { echo "Creating the Access app failed (token needs Access: Apps and Policies Edit)."; exit 1; }
  fi
  app_id=$(jq -r .id <<<"$app")
  if ! api "/accounts/$acct/access/apps/$app_id/policies" | jq -e --arg t "$tok" '.result[]? | select(any(.include[]?; .service_token.token_id == $t))' >/dev/null; then
    body=$(jq -n --arg t "$tok" '{name: "runners", decision: "non_identity", include: [{service_token: {token_id: $t}}]}')
    api "/accounts/$acct/access/apps/$app_id/policies" -X POST --data "$body" | jq -e .success >/dev/null || { echo "Adding the runners Service Auth policy failed."; exit 1; }
  fi
  w() { npx --prefix worker wrangler --cwd worker "$@"; }
  # A Worker secret write can hit a transient Cloudflare 500 ("internal authentication error"): up to 3 tries.
  sput() { local v; v=$(cat); for i in 1 2 3; do printf '%s' "$v" | w secret put "$1" >/dev/null && return 0; [ "$i" = 3 ] || { echo "secret $1: retrying"; sleep 5; }; done; return 1; }
  printf '%s' "$team" | sput ACCESS_TEAM_DOMAIN
  jq -j .aud <<<"$app" | sput ACCESS_AUD
  printf '%s' "$owners" | sput OWNERS
  cat "$creds" >> "$conf/live.env"
  echo "sign-in: $team, allowed: $owners; runner service token in $conf/live.env"
fi

# Your own GitHub release workflow's secrets, only when asked (CINDER_GH_SECRETS=1): a clone of someone else's repo must
# never push your Cloudflare credentials to it.
if [ "${CINDER_GH_SECRETS:-}" = 1 ]; then
  rel=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CINDER_OWNER_TOKEN)
  [ "${CINDER_ACCESS:-1}" = 0 ] || rel+=(CINDER_ACCESS_CLIENT_ID CINDER_ACCESS_CLIENT_SECRET)
  . "$conf/live.env" # now also holds the Access service token
  # shellcheck disable=SC2034 # read through ${!n} below
  CLOUDFLARE_ACCOUNT_ID=$acct CINDER_OWNER_TOKEN=$CINDER_TOKEN
  for n in "${rel[@]}"; do printf '%s' "${!n}" | gh secret set "$n" >/dev/null || { echo "gh secret set $n failed: set it by hand"; }; done
  echo "GitHub release secrets: ${rel[*]}"
fi

printf '\ncinder is live: %s\n' "$CINDER_URL"
