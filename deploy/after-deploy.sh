#!/usr/bin/env bash
# make up, after install.sh: what the release workflow does after its deploy, with no GitHub.
# Waits for the Worker's health and for the container apps (wrangler deploy builds the images). make seed fills it.
set -euo pipefail
cd "$(dirname "$0")/.."
conf=${CINDER_CONF:-$HOME/.config/cinder}
set -a
# shellcheck disable=SC1091
. "$conf/cloudflare.env"; . "$conf/live.env"
set +a
acct=${CF_ACCOUNT_ID:?}
H=(-H "Authorization: Bearer $CINDER_TOKEN")
[ -z "${CINDER_ACCESS_CLIENT_ID:-}" ] || H+=(-H "CF-Access-Client-Id: $CINDER_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CINDER_ACCESS_CLIENT_SECRET")
step() { printf '\n== %s\n' "$*"; }

step "health"
for i in $(seq 1 30); do curl -fsS "${H[@]}" "$CINDER_URL/api/health" && echo && break; [ "$i" -lt 30 ] || { echo "health never answered"; exit 1; }; sleep 10; done

step "container apps"
# lazy: one app per container class in wrangler.jsonc, each ready when it has a version and a healthy instance (a
# version alone can't take a start yet: "no container instance can be provided"); wait up to 30 min for the images.
want=$(grep -o '"image":' worker/wrangler.jsonc | wc -l)
for i in $(seq 1 90); do
  have=$(curl -sS "https://api.cloudflare.com/client/v4/accounts/$acct/containers/applications?per_page=100" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    | jq '[.result[]? | select(.name | startswith("cinder")) | select(.version != null and (.health.instances.healthy // 0) > 0)] | length')
  echo "$have of $want container apps ready"
  [ "${have:-0}" -ge "$want" ] && break; [ "$i" -lt 90 ] || { echo "container apps not ready"; exit 1; }; sleep 20
done
