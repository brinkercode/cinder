#!/usr/bin/env bash
# Run by runner/internal/install/install_test.go. Runs deploy/teardown.sh against a stubbed curl: a fake Cloudflare account
# whose resources are lines in $STATE/res ("kind|name"); a DELETE removes the line and is logged in $STATE/log.
set -euo pipefail
src=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/deploy" "$tmp/repo/worker" "$tmp/bin" "$tmp/state" "$tmp/conf"
cp "$src/teardown.sh" "$tmp/repo/deploy/"
cp "$src/../worker/wrangler.jsonc" "$tmp/repo/worker/"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
method=GET data=
while [ $# -gt 0 ]; do
  case $1 in -X) method=$2; shift ;; --data) data=$2; shift ;; https://*) path=${1#https://api.cloudflare.com/client/v4/accounts/acct1} ;; esac
  shift
done
res=$STATE/res
ok() { echo "{\"success\":true,\"result\":${1:-null}}"; }
no() { echo '{"success":false}'; }
has() { grep -qxF "$1|$2" "$res"; }
names() { { grep "^$1|" "$res" || true; } | cut -d'|' -f2; }
rows() { names "$1" | jq -Rc "{id: ., name: ., $2: ., uuid: ., queue_id: .}" | jq -sc .; } # one fake id (= the name) per kind
# The teardown deletes Artifacts repos in parallel: one lock per state change keeps the fake account consistent.
drop() { ( flock 9; echo "$method $path" >> "$STATE/log"; grep -vxF "$1|$2" "$res" > "$res.new.$$" || true; mv "$res.new.$$" "$res" ) 9>"$STATE/lock"; }
kind=${path#/}; kind=${kind%%[/?]*}
case "$method $path" in
  "GET /artifacts/namespaces/cinder") has ns cinder && ok || no ;;
  "GET /artifacts/namespaces/cinder/repos?limit=200") ok "$(rows repo name)" ;;
  "DELETE /artifacts/namespaces/cinder/repos/"*) has repo "${path##*/}" && { drop repo "${path##*/}"; ok; } || no ;;
  "DELETE /artifacts/namespaces/cinder") [ -z "$(names repo)" ] && { drop ns cinder; ok; } || no ;;
  "GET /workers/scripts/"*/settings) w=${path#/workers/scripts/}; has worker "${w%/settings}" && ok || no ;;
  "DELETE /workers/scripts/"*"?force=true") w=${path#/workers/scripts/}; drop worker "${w%?force=true}"; ok ;;
  "GET /workers/scripts") ok "$(rows worker id)" ;;
  "GET /d1/database?per_page=100") ok "$(rows d1 name)" ;;
  "GET /storage/kv/namespaces?per_page=100") ok "$(rows kv title)" ;;
  "DELETE /storage/kv/namespaces/"*) drop kv "${path##*/}"; ok ;;
  "GET /containers/applications?per_page=100") ok "$(rows app name)" ;;
  "DELETE /containers/applications/"*) drop app "${path##*/}"; ok ;;
  "GET /workflows/"*) has workflow "${path##*/}" && ok || no ;;
  "DELETE /workflows/"*) drop workflow "${path##*/}"; ok ;;
  "GET /queues?per_page=100") ok "$(rows queue queue_name)" ;;
  "DELETE /queues/"*) drop queue "${path##*/}"; ok ;;
  "GET /d1/database?name="*) ok "$(rows d1 name)" ;;
  "DELETE /d1/database/"*) drop d1 "${path##*/}"; ok ;;
  "GET /vectorize/v2/indexes/"*) has vectorize "${path##*/}" && ok || no ;;
  "DELETE /vectorize/v2/indexes/"*) drop vectorize "${path##*/}"; ok ;;
  "GET /r2/buckets?name_contains="*) ok "{\"buckets\":$(rows bucket name)}" ;;
  "GET /r2/buckets/"*"/objects?per_page=1000") b=${path#/r2/buckets/}; b=${b%%/*}
    ok "$({ grep "^obj|$b/" "$res" || true; } | head -2 | sed "s/^obj|$b\///" | jq -Rc '{key: .}' | jq -sc .)" ;;
  "DELETE /r2/buckets/"*"/objects") b=${path#/r2/buckets/}; b=${b%%/*}
    for k in $(jq -r '.[]' <<<"$data"); do drop obj "$b/$k"; done; ok ;;
  "DELETE /r2/buckets/"*) b=${path##*/}; if grep -q "^obj|$b/" "$res"; then no; else drop bucket "$b"; ok; fi ;;
  "GET /ai-gateway/gateways/cinder") has gateway cinder && ok || no ;;
  "GET /ai-gateway/gateways/cinder/provider_configs") ok "$(rows pconfig id)" ;;
  "DELETE /ai-gateway/gateways/cinder/provider_configs/"*) drop pconfig "${path##*/}"; ok ;;
  "DELETE /ai-gateway/gateways/cinder") drop gateway cinder; ok ;;
  "GET /secrets_store/stores") ok '[{"id":"store1"}]' ;;
  "GET /secrets_store/stores/store1/secrets?per_page=100") ok "$(rows secret name)" ;;
  "DELETE /secrets_store/stores/store1/secrets/"*) drop secret "${path##*/}"; ok ;;
  "GET /access/apps") ok "$(rows app-access name | jq -c '[.[] | .domain = "cinder.me.workers.dev" | .name = "cinder"]')" ;;
  "DELETE /access/apps/"*) drop app-access "${path##*/}"; ok ;;
  "GET /access/service_tokens") ok "$(rows token name | jq -c '[.[] | .name = "cinder-runners"]')" ;;
  "DELETE /access/service_tokens/"*) drop token "${path##*/}"; ok ;;
  *) no ;;
esac
SH
chmod +x "$tmp/bin/curl" "$tmp/repo/deploy/teardown.sh"
fill() { cat > "$tmp/state/res" <<'R'
ns|cinder
repo|svc-orders-go
repo|svc-orders-go--c12
repo|cinder-agents
worker|cinder
worker|cinder-secrets
app|cinder-workerlite
app|cinder-cisandbox
workflow|cinder-pipeline
workflow|cinder-reset
workflow|cinder-seed
queue|cinder-events
queue|cinder-events-dlq
queue|cinder-webhooks
queue|cinder-webhooks-dlq
d1|cinder
d1|pulse-db-staging
d1|pulse-db-c0123abcdX
d1|pulse-db
kv|pulse-cache-production
worker|pulse-preview
worker|web-store-c0123abcd
worker|pulse
vectorize|cinder-vulns
bucket|cinder-ci-cache
bucket|cinder-logs
obj|cinder-logs/a
obj|cinder-logs/b
obj|cinder-logs/c
obj|cinder-ci-cache/x
gateway|cinder
pconfig|openai-1
secret|cinder_merge_signing_key
secret|cinder_1234
app-access|cinder
token|cinder-runners
R
  : > "$tmp/state/log"
  printf 'CLOUDFLARE_API_TOKEN=tok\nCF_ACCOUNT_ID=acct1\n' > "$tmp/conf/cloudflare.env"
  echo CINDER_URL=x > "$tmp/conf/live.env"; echo ID=x > "$tmp/conf/access.env"
}
down() { PATH="$tmp/bin:$PATH" STATE="$tmp/state" CINDER_CONF="$tmp/conf" "$tmp/repo/deploy/teardown.sh" "$@"; }
fail() { echo "FAIL: $*"; exit 1; }
fill

case ${1:-} in
deletes-everything) # every resource kind goes, buckets are emptied first, the API token stays
  CINDER_YES=1 down > "$tmp/out" || fail "teardown failed: $(cat "$tmp/out")"
  [ "$(tr '\n' ' ' < "$tmp/state/res")" = "d1|pulse-db-c0123abcdX d1|pulse-db worker|pulse " ] || fail "left behind (want only the lookalikes): $(cat "$tmp/state/res")"
  [ -s "$tmp/conf/cloudflare.env" ] || fail "cloudflare.env was removed"
  [ ! -e "$tmp/conf/live.env" ] && [ ! -e "$tmp/conf/access.env" ] || fail "live.env or access.env kept"
  first=$(head -1 "$tmp/state/log"); [[ $first == *artifacts* ]] || fail "Artifacts did not go first: $first"
  # Live, Cloudflare refused to delete the Worker while its container apps existed, so the apps go first.
  grep -n 'DELETE /workers/scripts/cinder?\|DELETE /containers' "$tmp/state/log" | sort -t: -k1 -n | head -1 | grep -q containers || fail "container apps did not precede the Worker"
  w=$(grep -n 'DELETE /workers/scripts/cinder?' "$tmp/state/log" | cut -d: -f1); q=$(grep -n 'DELETE /queues/' "$tmp/state/log" | head -1 | cut -d: -f1)
  [ -n "$w" ] && [ -n "$q" ] && [ "$w" -lt "$q" ] || fail "the Worker did not precede its queues"
  [ "$(grep -n 'objects$' "$tmp/state/log" | tail -1 | cut -d: -f1)" -lt "$(grep -n 'DELETE /r2/buckets/cinder-logs$' "$tmp/state/log" | cut -d: -f1)" ] || fail "bucket deleted before it was emptied"
  grep -q 'deleted Artifacts repo cinder/svc-orders-go--c12' "$tmp/out" || fail "a fork was not printed as deleted" ;;
dry-run) # --dry-run lists the deletions and deletes nothing
  before=$(cat "$tmp/state/res")
  down --dry-run > "$tmp/out" || fail "dry run failed"
  [ "$(cat "$tmp/state/res")" = "$before" ] || fail "dry run changed the account"
  ! grep -q DELETE "$tmp/state/log" || fail "dry run sent a DELETE"
  [ -e "$tmp/conf/live.env" ] || fail "dry run removed live.env"
  for w in "would delete Worker cinder-secrets" "would empty and delete R2 bucket cinder-logs" "would delete Artifacts repo cinder/cinder-agents"; do grep -q "$w" "$tmp/out" || fail "not listed: $w"; done ;;
second-run) # a second run finds nothing, deletes nothing and succeeds
  CINDER_YES=1 down >/dev/null; : > "$tmp/state/log"
  CINDER_YES=1 down > "$tmp/out" || fail "second run failed: $(cat "$tmp/out")"
  [ ! -s "$tmp/state/log" ] || fail "second run deleted: $(cat "$tmp/state/log")"
  grep -q 'skip    Worker cinder (not found)' "$tmp/out" || fail "no skip line: $(cat "$tmp/out")" ;;
confirm) # a wrong account id deletes nothing; the right one proceeds
  ! echo wrong | down > "$tmp/out" || fail "wrong id accepted"
  [ -s "$tmp/state/res" ] && [ ! -s "$tmp/state/log" ] || fail "deleted without confirmation"
  echo acct1 | down >/dev/null || fail "right id refused"
  grep -q "^worker|cinder$" "$tmp/state/res" && fail "nothing deleted after confirming"; true ;;
*) fail "usage: $0 deletes-everything|dry-run|second-run|confirm" ;;
esac
