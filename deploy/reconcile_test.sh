#!/usr/bin/env bash
# Run by runner/internal/install/install_test.go. Runs deploy/reconcile.sh against a stubbed curl (a fake Cloudflare API).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/deploy" "$tmp/repo/worker" "$tmp/bin" "$tmp/state"
cp "$here/reconcile.sh" "$tmp/repo/deploy/"
printf '{ "d1_databases": [{ "database_name": "cinder" }], "artifacts": [{ "namespace": "cinder" }],\n  "queues": { "producers": [{ "queue": "cinder-events" }] }, "r2_buckets": [{ "bucket_name": "cinder-ci-cache" }] }\n' > "$tmp/repo/worker/wrangler.jsonc"
cat > "$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
method=GET
while [ $# -gt 0 ]; do
  case $1 in -X) method=$2; shift ;; --data-binary) { cat "${2#@}"; echo; } >> "$STATE/data"; shift ;; https://*) path=${1#https://api.cloudflare.com/client/v4/accounts/acct1} ;; esac
  shift
done
echo "$method $path" >> "$STATE/calls"
case "$method $path" in
  "GET /ai-gateway/gateways/cinder") [ -e "$STATE/gateway" ] && echo "{\"success\":true,\"result\":{\"id\":\"cinder\",\"store_id\":\"$(cat "$STATE/gw_store" 2>/dev/null)\",\"authentication\":$(cat "$STATE/gw_auth" 2>/dev/null || echo false)}}" || echo '{"success":false}' ;;
  "PUT /ai-gateway/gateways/cinder") tail -1 "$STATE/data" | jq -r .store_id > "$STATE/gw_store"; tail -1 "$STATE/data" | jq -r .authentication > "$STATE/gw_auth"; echo '{"success":true}' ;;
  "POST /ai-gateway/gateways") [ -z "${NO_GW_PERM:-}" ] || { echo '{"success":false}'; exit 0; }; touch "$STATE/gateway"; echo '{"success":true}' ;;
  "GET /secrets_store/stores") [ -e "$STATE/store" ] && echo '{"success":true,"result":[{"id":"s1"}]}' || echo '{"success":true,"result":[]}' ;;
  "POST /secrets_store/stores") touch "$STATE/store"; echo '{"success":true}' ;;
  "GET /secrets_store/stores/s1/secrets?search="*) n=${path#*search=}; [ -e "$STATE/secret-$n" ] && echo "{\"success\":true,\"result\":[{\"name\":\"$n\"}]}" || echo '{"success":true,"result":[]}' ;;
  "POST /secrets_store/stores/s1/secrets") touch "$STATE/secret-$(tail -1 "$STATE/data" | jq -r '.[0].name')"; echo '{"success":true}' ;;
  "GET /workers/scripts/cinder-secrets/settings") [ -e "$STATE/secrets-worker" ] && echo '{"success":true,"result":{"bindings":[]}}' || echo '{"success":false}' ;;
  "GET /d1/database?name=cinder") echo '{"success":true,"result":[{"name":"cinder","uuid":"db-uuid-1"}]}' ;;
  "GET /workers/scripts/cinder/secrets") [ -e "$STATE/worker" ] || { echo '{"success":false}'; exit 0; }
    jq -c '{success: true, result: map({name: ., type: "secret_text"})}' <<<"$( [ -s "$STATE/wsecrets" ] && cat "$STATE/wsecrets" || echo '[]')" ;;
  "PUT /workers/scripts/cinder/secrets") n=$(tail -1 "$STATE/data" | jq -r .name)
    jq -c --arg n "$n" '. + [$n]' <<<"$( [ -s "$STATE/wsecrets" ] && cat "$STATE/wsecrets" || echo '[]')" > "$STATE/wsecrets.new"; mv "$STATE/wsecrets.new" "$STATE/wsecrets"; echo '{"success":true}' ;;
  "GET /workers/subdomain") echo '{"success":true,"result":{"subdomain":"me"}}' ;;
  "GET /access/organizations") echo '{"success":true,"result":{"auth_domain":"team.cloudflareaccess.com"}}' ;;
  "GET /access/apps") echo "{\"success\":true,\"result\":[{\"id\":\"app1\",\"domain\":\"cinder.me.workers.dev\",\"aud\":\"aud1\",\"policies\":[{\"id\":\"p1\",\"precedence\":1,\"name\":\"owners\"}]$(cat "$STATE/samesite" 2>/dev/null)}]}" ;;
  "PUT /access/apps/app1") tail -1 "$STATE/data" > "$STATE/app"; echo ',"same_site_cookie_attribute":"lax"' > "$STATE/samesite"; echo '{"success":true}' ;;
  "GET /queues?per_page=100") echo '{"success":true,"result":[{"queue_name":"cinder-events"}]}' ;;
  "POST /queues") echo '{"success":true}' ;;
  "GET /r2/buckets?name_contains=cinder-ci-cache") echo '{"success":true,"result":{"buckets":[{"name":"cinder-ci-cache"}]}}' ;;
  "GET /r2/buckets?name_contains=cinder-logs") echo '{"success":true,"result":{"buckets":[{"name":"cinder-logs"}]}}' ;;
  "GET /r2/buckets/cinder-logs/lifecycle") echo "{\"success\":true,\"result\":{\"rules\":$(cat "$STATE/lifecycle" 2>/dev/null || echo '[{"id":"other"}]')}}" ;;
  "PUT /r2/buckets/cinder-logs/lifecycle") tail -1 "$STATE/data" | jq -c .rules > "$STATE/lifecycle"; echo '{"success":true}' ;;
  "GET /artifacts/namespaces/cinder/repos") echo '{"success":true,"result":[]}' ;;
  "GET /artifacts/namespaces/cinder/repos/cinder-wiki") [ -e "$STATE/wiki" ] && echo '{"success":true,"result":{"name":"cinder-wiki"}}' || echo '{"success":false,"errors":[{"code":10404}]}' ;;
  "POST /artifacts/namespaces/cinder/repos") touch "$STATE/wiki"; echo '{"success":true}' ;;
  *) echo '{"success":false}' ;;
esac
FAKE
printf '#!/usr/bin/env bash\necho "$*" >> "$STATE/npx"; touch "$STATE/secrets-worker"\n' > "$tmp/bin/npx"
chmod +x "$tmp/bin/curl" "$tmp/bin/npx"
run() { PATH="$tmp/bin:$PATH" STATE="$tmp/state" CLOUDFLARE_API_TOKEN=tok CLOUDFLARE_ACCOUNT_ID=acct1 "$tmp/repo/deploy/reconcile.sh"; }
fail() { echo "FAIL: $*"; exit 1; }
gw_posts() { grep -c '^POST /ai-gateway/gateways$' "$tmp/state/calls" || true; }

case ${1:-} in
gateway) # a missing gateway is created; an existing one is left untouched
  run >/dev/null
  [ "$(gw_posts)" = 1 ] || fail "missing gateway not created: $(cat "$tmp/state/calls")"
  : > "$tmp/state/calls"
  run >/dev/null
  [ "$(gw_posts)" = 0 ] || fail "existing gateway touched: $(cat "$tmp/state/calls")"
  ! grep -q '^POST' "$tmp/state/calls" || fail "existing resources recreated: $(cat "$tmp/state/calls")" ;;
secrets-store) # a missing Secrets Store store is created; an existing one is left untouched
  run >/dev/null
  [ "$(grep -c '^POST /secrets_store/stores$' "$tmp/state/calls")" = 1 ] || fail "missing store not created: $(cat "$tmp/state/calls")"
  : > "$tmp/state/calls"
  run >/dev/null
  ! grep -q '^POST /secrets_store' "$tmp/state/calls" || fail "existing store touched: $(cat "$tmp/state/calls")"
  # the gateway is linked to the store (stored provider keys need it), and only once
  [ "$(cat "$tmp/state/gw_store" 2>/dev/null)" = s1 ] || fail "gateway not linked to store s1"
  ! grep -q '^PUT /ai-gateway' "$tmp/state/calls" || fail "already-linked gateway updated again: $(cat "$tmp/state/calls")" ;;
gateway-auth) # authentication is turned on for a gateway that has it off, and an authenticated one is left untouched
  run >/dev/null
  echo false > "$tmp/state/gw_auth"
  : > "$tmp/state/calls"
  run >/dev/null
  [ "$(cat "$tmp/state/gw_auth")" = true ] || fail "gateway authentication not enabled: $(cat "$tmp/state/calls")"
  : > "$tmp/state/calls"
  run >/dev/null
  ! grep -q '^PUT /ai-gateway' "$tmp/state/calls" || fail "authenticated gateway updated again: $(cat "$tmp/state/calls")" ;;
merge-signing) # the merge-signing and live-ticket secrets are created once and bound with the resolved store id, never twice
  run >/dev/null
  [ "$(grep -c '^POST /secrets_store/stores/s1/secrets$' "$tmp/state/calls")" = 2 ] || fail "secrets not created: $(cat "$tmp/state/calls")"
  : > "$tmp/state/calls"
  run >/dev/null
  ! grep -q '^POST /secrets_store' "$tmp/state/calls" || fail "existing signing secret touched: $(cat "$tmp/state/calls")"
  [ "$(grep -c '"binding": "MERGE_SIGNING_KEY", "store_id": "s1", "secret_name": "cinder_merge_signing_key" }, { "binding": "LIVE_TICKET_KEY", "store_id": "s1", "secret_name": "cinder_live_ticket_key"' "$tmp/repo/worker/wrangler.jsonc")" = 1 ] \
    || fail "binding not written once: $(cat "$tmp/repo/worker/wrangler.jsonc")" ;;
gateway-denied) # a create the token can't make fails and names the permission
  if out=$(NO_GW_PERM=1 run 2>&1); then fail "reconcile succeeded without the permission"; fi
  grep -q 'AI Gateway: Edit' <<<"$out" || fail "error doesn't name AI Gateway: Edit: $out" ;;
dlq) # each consumer's dead-letter queue is created when missing
  sed -i 's/"producers": \[{ "queue": "cinder-events" }\]/"consumers": [{ "queue": "cinder-events", "dead_letter_queue": "cinder-events-dlq" }, { "queue": "cinder-webhooks", "dead_letter_queue": "cinder-webhooks-dlq" }]/' "$tmp/repo/worker/wrangler.jsonc"
  run >/dev/null
  for q in cinder-events-dlq cinder-webhooks-dlq; do
    grep -qx "{\"queue_name\":\"$q\"}" "$tmp/state/data" || fail "$q not created: $(cat "$tmp/state/data")"
  done ;;
secrets-worker) # a missing cinder-secrets Worker is deployed; an existing one is left untouched
  run >/dev/null
  [ "$(cat "$tmp/state/npx")" = "--prefix worker wrangler --cwd worker/secrets deploy" ] || fail "cinder-secrets not deployed: $(cat "$tmp/state/npx" 2>/dev/null)"
  run >/dev/null
  [ "$(wc -l < "$tmp/state/npx")" = 1 ] || fail "existing cinder-secrets redeployed: $(cat "$tmp/state/npx")" ;;
d1-id) # the account's D1 id and account id replace the committed ones
  sed -i 's/"database_name": "cinder"/"database_name": "cinder", "database_id": "old"/; 1s/^/{ "vars": { "CF_ACCOUNT_ID": "old" },\n/; 2s/^{//' "$tmp/repo/worker/wrangler.jsonc"
  run >/dev/null
  cfg=$(cat "$tmp/repo/worker/wrangler.jsonc")
  grep -q '"database_id": "db-uuid-1"' <<<"$cfg" || fail "database_id not written: $cfg"
  grep -q '"CF_ACCOUNT_ID": "acct1"' <<<"$cfg" || fail "account id not written: $cfg"
  ! grep -q '"CLOUDFLARE_ACCOUNT_ID"' <<<"$cfg" || fail "unused CLOUDFLARE_ACCOUNT_ID var written: $cfg"
  ! grep -q '"old"' <<<"$cfg" || fail "committed value left: $cfg" ;;
worker-secrets) # missing Worker secrets are put once; an existing one is never overwritten; no Worker means none are put
  run >/dev/null
  ! grep -q '^PUT /workers/scripts' "$tmp/state/calls" || fail "put secrets with no Worker: $(cat "$tmp/state/calls")"
  touch "$tmp/state/worker"; echo '["OWNER_TOKEN"]' > "$tmp/state/wsecrets"
  OWNERS=me@x.com run >/dev/null
  for n in CF_DEPLOY_TOKEN OWNERS ACCESS_TEAM_DOMAIN ACCESS_AUD; do jq -e --arg n "$n" 'index($n)' "$tmp/state/wsecrets" >/dev/null || fail "$n not put: $(cat "$tmp/state/wsecrets")"; done
  [ "$(jq -r 'map(select(. == "OWNER_TOKEN")) | length' "$tmp/state/wsecrets")" = 1 ] || fail "OWNER_TOKEN overwritten"
  : > "$tmp/state/calls"
  OWNERS=me@x.com run >/dev/null
  ! grep -q '^PUT /workers/scripts' "$tmp/state/calls" || fail "existing secrets put again: $(cat "$tmp/state/calls")"
  rm "$tmp/state/wsecrets"
  run >/dev/null
  jq -e 'index("OWNER_TOKEN")' "$tmp/state/wsecrets" >/dev/null || fail "missing OWNER_TOKEN not generated" ;;
logs-lifecycle) # a bound cinder-logs gets the flows/ and artifacts/ 30-day expiries once, next to its other rules
  sed -i 's/"bucket_name": "cinder-ci-cache" }/"bucket_name": "cinder-ci-cache" }, { "bucket_name": "cinder-logs" }/' "$tmp/repo/worker/wrangler.jsonc"
  run >/dev/null
  jq -e 'map(.id) == ["other", "cinder-flow-logs-30d", "cinder-flow-artifacts-30d"] and .[1].conditions.prefix == "flows/" and .[2].conditions.prefix == "artifacts/"
    and all(.[1:][]; .deleteObjectsTransition.condition.maxAge == 2592000)' "$tmp/state/lifecycle" >/dev/null \
    || fail "lifecycle rule not set: $(cat "$tmp/state/lifecycle")"
  : > "$tmp/state/calls"
  run >/dev/null
  ! grep -q '^PUT /r2/' "$tmp/state/calls" || fail "existing lifecycle rule set again: $(cat "$tmp/state/calls")" ;;
access-cookie) # the Access app's cookie is set to SameSite=Lax once, keeping its policies
  run >/dev/null
  jq -e '.same_site_cookie_attribute == "lax" and .policies == [{"id": "p1", "precedence": 1}]' "$tmp/state/app" >/dev/null || fail "cookie not set to lax: $(cat "$tmp/state/app" 2>/dev/null)"
  : > "$tmp/state/calls"
  run >/dev/null
  ! grep -q '^PUT /access' "$tmp/state/calls" || fail "lax cookie set again: $(cat "$tmp/state/calls")" ;;
*) echo "usage: $0 access-cookie|d1-id|worker-secrets|gateway|gateway-auth|gateway-denied|secrets-store|merge-signing|dlq|secrets-worker|logs-lifecycle"; exit 2 ;;
esac
