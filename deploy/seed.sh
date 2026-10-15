#!/usr/bin/env bash
# make seed, after make up: seeds with --full and warms the pages, as the release workflow does after its deploy.
# It also imports and deploys pulse (seed/demo.mjs --setup); CINDER_DEMO=1 also files the demo's intents.
set -euo pipefail
cd "$(dirname "$0")/.."
conf=${CINDER_CONF:-$HOME/.config/cinder}
set -a
# shellcheck disable=SC1091
. "$conf/cloudflare.env"; . "$conf/live.env"
set +a
# curl reads the headers from a process substitution (-H @<(hdr)) so the tokens never show in the process list.
hdr() {
  printf 'Authorization: Bearer %s\n' "$CINDER_TOKEN"
  [ -z "${CINDER_ACCESS_CLIENT_ID:-}" ] || printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$CINDER_ACCESS_CLIENT_ID" "$CINDER_ACCESS_CLIENT_SECRET"
}
step() { printf '\n== %s\n' "$*"; }

step "seed"
node seed/seed.mjs --full
# pulse is always imported and deployed, so Environments has live environments; CINDER_DEMO=1 also files its intents.
if [ "${CINDER_DEMO:-}" = 1 ]; then node seed/demo.mjs; else node seed/demo.mjs --setup; fi

step "warm"
get() { curl -sS -o /dev/null -w "%{http_code} %{time_total}s $1\n" -H @<(hdr) "$CINDER_URL$1" || true; }
for r in $(curl -fsS -H @<(hdr) "$CINDER_URL/api/repos" | jq -r '(if type=="array" then . else .repos end)[] | "\(.name | @uri)=\(.default_branch)"'); do
  e=${r%%=*}; b=${r#*=}
  for p in "" "/tree?ref=$b&path=&recursive=1" /changes /branches "/flows?ref=$b"; do get "/api/repos/$e$p"; done
done
