#!/usr/bin/env bash
# Creates every Cloudflare resource cinder runs on that is missing. Never deletes one; it changes only the settings named below.
# Shared by cloudflare-up.sh (make up) and release.yml. Needs CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID).
# It also writes this account's D1 id and account id into worker/wrangler.jsonc (the deploy config), and puts any Worker secret
# that is missing (OWNER_TOKEN, CF_DEPLOY_TOKEN, Access values) without overwriting one that exists.
# Names come from worker/wrangler.jsonc, so a newly bound queue, bucket or index lands on the next release.
set -euo pipefail
cd "$(dirname "$0")/.."
acct=${CF_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:?set CF_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID}}
tok=${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}
base="https://api.cloudflare.com/client/v4/accounts/$acct"
cfg=worker/wrangler.jsonc

# api METHOD PATH [JSON]: prints the response body; exits non-zero unless Cloudflare reports success.
api() {
  local out
  out=$(curl -sS -X "$1" "$base$2" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" ${3:+--data "$3"}) || return 1
  jq -e .success >/dev/null 2>&1 <<<"$out" || return 1
  printf '%s' "$out"
}
die() { echo "reconcile: $1: the token needs $2" >&2; exit 1; }
names() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" "$cfg" | sed 's/.*"\([^"]*\)"$/\1/' | sort -u; }

# ensure LABEL PERMISSION GET_PATH FILTER POST_PATH POST_JSON: FILTER is a jq test on the GET body that is true when present.
ensure() {
  local got
  got=$(api GET "$3") || die "can't read $1" "$2"
  if jq -e "$4" >/dev/null <<<"$got"; then echo "$1 exists"; return; fi
  api POST "$5" "$6" >/dev/null || die "can't create $1" "$2"
  echo "$1 created"
}

# A missing gateway is a 404 (success false), so it is probed by id rather than listed.
if api GET /ai-gateway/gateways/cinder >/dev/null; then echo "AI Gateway cinder exists"
else
  api POST /ai-gateway/gateways '{"id":"cinder","collect_logs":true,"cache_ttl":0,"cache_invalidate_on_update":false,
    "rate_limiting_interval":0,"rate_limiting_limit":0,"rate_limiting_technique":"fixed"}' >/dev/null \
    || die "can't create AI Gateway cinder" "AI Gateway: Edit"
  echo "AI Gateway cinder created"
fi

# The keystore's values live in Secrets Store (one store per account in the beta); cinder uses the account's store.
ensure "Secrets Store store" "Secrets Store: Edit" /secrets_store/stores "(.result | length) > 0" /secrets_store/stores '{"name":"cinder"}'
# The Worker signs merge commits with keys derived from this secret (worker/src/signing.js); its value stays in the store.
# The binding's store_id is resolved here and written into the deploy config, never committed.
store=$(api GET /secrets_store/stores | jq -er '.result[0].id') || die "can't read the Secrets Store store id" "Secrets Store: Edit"
# The gateway's stored provider keys live in that store: link it (an unlinked gateway refuses every provider key), and
# require authentication so only cinder spends them. The Worker's AI binding is authenticated by the account itself,
# so no gateway token exists to set.
gw=$(api GET /ai-gateway/gateways/cinder | jq -c .result) || die "can't read AI Gateway cinder" "AI Gateway: Edit"
if [ "$(jq -r '.store_id // ""' <<<"$gw")" != "$store" ] || [ "$(jq -r '.authentication' <<<"$gw")" != true ]; then
  body=$(jq -c --arg s "$store" '{cache_invalidate_on_update, cache_ttl, collect_logs, rate_limiting_interval, rate_limiting_limit, rate_limiting_technique, store_id: $s, authentication: true}' <<<"$gw")
  api PUT /ai-gateway/gateways/cinder "$body" >/dev/null || die "can't link AI Gateway cinder to the Secrets Store" "AI Gateway: Edit"
  echo "AI Gateway cinder linked to Secrets Store $store, authentication on"
else echo "AI Gateway cinder linked to Secrets Store, authentication on"; fi
# LIVE_TICKET_KEY signs the short-lived live-update socket tickets (worker/src/live.js).
for name in cinder_merge_signing_key cinder_live_ticket_key; do
  ensure "Secrets Store secret $name" "Secrets Store: Edit" "/secrets_store/stores/$store/secrets?search=$name" \
    "any(.result[]; .name == \"$name\")" "/secrets_store/stores/$store/secrets" \
    "[{\"name\":\"$name\",\"value\":\"$(openssl rand -hex 32)\",\"scopes\":[\"workers\"],\"comment\":\"cinder ${name#cinder_}\"}]"
done
binding="  \"secrets_store_secrets\": [{ \"binding\": \"MERGE_SIGNING_KEY\", \"store_id\": \"$store\", \"secret_name\": \"cinder_merge_signing_key\" }, { \"binding\": \"LIVE_TICKET_KEY\", \"store_id\": \"$store\", \"secret_name\": \"cinder_live_ticket_key\" }],"
# Text edit, not JSON.parse: the file is JSONC. Any earlier binding line is replaced, so a re-run never duplicates it.
awk -v l="$binding" 'index($0, "\"MERGE_SIGNING_KEY\"") { next } { print } NR == 1 { print l }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
echo "MERGE_SIGNING_KEY and LIVE_TICKET_KEY bound to store $store"
# cinder-secrets (worker/secrets) holds the keystore's per-secret bindings; cinder's SECRETS service binding needs it.
if api GET /workers/scripts/cinder-secrets/settings >/dev/null; then echo "Worker cinder-secrets exists"
else
  npx --prefix worker wrangler --cwd worker/secrets deploy >/dev/null || die "can't create Worker cinder-secrets" "Workers Scripts: Edit"
  echo "Worker cinder-secrets created"
fi
for db in $(names database_name); do
  ensure "D1 database $db" "D1: Edit" "/d1/database?name=$db" "any(.result[]; .name == \"$db\")" /d1/database "{\"name\":\"$db\"}"
done
for q in $(names queue) $(names dead_letter_queue); do
  ensure "Queue $q" "Queues: Edit" "/queues?per_page=100" "any(.result[]; .queue_name == \"$q\")" /queues "{\"queue_name\":\"$q\"}"
done
for b in $(names bucket_name); do
  ensure "R2 bucket $b" "Workers R2 Storage: Edit" "/r2/buckets?name_contains=$b" "any(.result.buckets[]; .name == \"$b\")" /r2/buckets "{\"name\":\"$b\"}"
done
# Flow step logs (worker/src/flow-logs.js) and flow artifacts (worker/src/flow-results.js) expire 30 days after they are
# written. The PUT replaces the bucket's rules, so any other rule is kept and only cinder's own are added when missing or different.
if names bucket_name | grep -qx cinder-logs; then
  for prefix in flows artifacts; do
    id=cinder-flow-logs-30d; [ "$prefix" = artifacts ] && id=cinder-flow-artifacts-30d
    rule="{\"id\":\"$id\",\"enabled\":true,\"conditions\":{\"prefix\":\"$prefix/\"},\"deleteObjectsTransition\":{\"condition\":{\"type\":\"Age\",\"maxAge\":2592000}}}"
    # A bucket that never had rules may answer the GET with an error; the PUT still names a missing permission.
    rules=$(api GET /r2/buckets/cinder-logs/lifecycle | jq -c '.result.rules // []') || rules='[]'
    if jq -e --argjson r "$rule" 'any(.[]; . == $r)' >/dev/null <<<"$rules"; then echo "R2 cinder-logs $prefix/ 30-day expiry exists"
    else
      api PUT /r2/buckets/cinder-logs/lifecycle "$(jq -c --argjson r "$rule" '{rules: ([.[] | select(.id != $r.id)] + [$r])}' <<<"$rules")" >/dev/null \
        || die "can't set the R2 cinder-logs lifecycle" "Workers R2 Storage: Edit"
      echo "R2 cinder-logs $prefix/ 30-day expiry set"
    fi
  done
fi
for ix in $(names index_name); do
  # lazy: creates 768-dim cosine (bge-base-en-v1.5); read dimensions from the binding when an index needs another model.
  ensure "Vectorize index $ix" "Vectorize: Edit" /vectorize/v2/indexes "any(.result[]; .name == \"$ix\")" /vectorize/v2/indexes \
    "{\"name\":\"$ix\",\"config\":{\"dimensions\":768,\"metric\":\"cosine\"}}"
done
# Analytics Engine datasets (analytics_engine_datasets) have no create API: each is created by the Worker's first write.
# Artifacts namespaces are implicit (created with their first repo); only check this token can reach each one.
for ns in $(names namespace); do
  # The Artifacts API answers transient errors now and then (two releases on 2026-10-07): try three times before failing.
  for try in 1 2 3; do api GET "/artifacts/namespaces/$ns/repos" >/dev/null && break; [ "$try" = 3 ] && die "can't reach Artifacts namespace $ns (Workers Paid plan required)" "Artifacts: Edit"; sleep 10; done
  echo "Artifacts namespace $ns reachable"
  # The org's one wiki (worker/src/wiki.js WIKI_REPO); pages are markdown files in it.
  # Looked up by name: the repo list is paged (50 a page), so a scan of page one misses it once the seed has imported more.
  if api GET "/artifacts/namespaces/$ns/repos/cinder-wiki" >/dev/null; then echo "Artifacts repo cinder-wiki exists"
  else api POST "/artifacts/namespaces/$ns/repos" '{"name":"cinder-wiki"}' >/dev/null || die "can't create Artifacts repo cinder-wiki" "Artifacts: Edit"; echo "Artifacts repo cinder-wiki created"; fi
done

# The deploy config carries this account's ids, not the ones committed. Text edits, not JSON.parse: the file is JSONC.
db_name=$(names database_name | head -1)
db_id=$(api GET "/d1/database?name=$db_name" | jq -er --arg n "$db_name" '.result[] | select(.name == $n) | .uuid') || die "can't read D1 database $db_name" "D1: Edit"
python3 - "$db_id" "$acct" <<'PY'
import re, sys
db, acct = sys.argv[1], sys.argv[2]
p = "worker/wrangler.jsonc"; s = open(p).read()
if re.search(r'"database_id"\s*:', s):
    s = re.sub(r'("database_id"\s*:\s*")[^"]*(")', lambda m: m.group(1) + db + m.group(2), s, count=1)
else:
    s = s.replace('"database_name": "cinder"', '"database_name": "cinder", "database_id": "%s"' % db, 1)
if '"CF_ACCOUNT_ID"' in s:
    s = re.sub(r'("CF_ACCOUNT_ID"\s*:\s*")[^"]*(")', lambda m: m.group(1) + acct + m.group(2), s, count=1)
elif re.search(r'"vars"\s*:\s*\{', s):
    s = re.sub(r'("vars"\s*:\s*\{)', lambda m: m.group(1) + ' "CF_ACCOUNT_ID": "%s",' % acct, s, count=1)
else:
    s = re.sub(r'(\n\s*"compatibility_date"[^\n]*\n)', lambda m: m.group(1) + '  "vars": { "CF_ACCOUNT_ID": "%s" },\n' % acct, s, count=1)
if '"AI_GATEWAY_ID"' not in s:
    s = re.sub(r'("vars"\s*:\s*\{)', lambda m: m.group(1) + ' "AI_GATEWAY_ID": "cinder",', s, count=1)
open(p, "w").write(s)
PY
echo "D1 id and account id written to $cfg"

# Worker secrets. Before the first deploy there is no Worker to hold them: a second run after the deploy puts them.
if have=$(api GET /workers/scripts/cinder/secrets); then
  has() { jq -e --arg n "$1" 'any(.result[]?; .name == $n)' >/dev/null <<<"$have"; }
  put() { # put NAME VALUE: only when NAME is missing and VALUE is not empty
    has "$1" && return 0
    [ -n "$2" ] || return 0
    api PUT /workers/scripts/cinder/secrets "$(jq -nc --arg n "$1" --arg v "$2" '{name: $n, text: $v, type: "secret_text"}')" >/dev/null || die "can't set Worker secret $1" "Workers Scripts: Edit"
    echo "Worker secret $1 set"
  }
  has OWNER_TOKEN || put OWNER_TOKEN "${CINDER_OWNER_TOKEN:-$(openssl rand -hex 32)}"
  put CF_DEPLOY_TOKEN "${CF_DEPLOY_TOKEN:-$tok}"
  put OWNERS "${OWNERS:-}"
  if ! has ACCESS_TEAM_DOMAIN || ! has ACCESS_AUD; then
    # make up creates Access; here its values are only read back, so a release on a fresh fork still gets them.
    sub=$(api GET /workers/subdomain | jq -r '.result.subdomain // empty' || true)
    put ACCESS_TEAM_DOMAIN "$(api GET /access/organizations | jq -r '.result.auth_domain // empty' || true)"
    [ -z "$sub" ] || put ACCESS_AUD "$(api GET /access/apps | jq -r --arg h "cinder.$sub.workers.dev" '[.result[]? | select(.domain == $h) | .aud][0] // empty' || true)"
  fi
  echo "Worker secrets checked"
else echo "Worker cinder not deployed yet: its secrets are put by the next run"; fi

# The Access app's cookie is SameSite=Lax, so another site's form POST doesn't carry it. Policies are kept by reference.
sub=$(api GET /workers/subdomain | jq -r '.result.subdomain // empty' || true)
app=$([ -z "$sub" ] || api GET /access/apps | jq -c --arg h "cinder.$sub.workers.dev" '[.result[]? | select(.domain == $h)][0] // empty' || true)
if [ -n "$app" ] && [ "$(jq -r '.same_site_cookie_attribute // ""' <<<"$app")" != lax ]; then
  api PUT "/access/apps/$(jq -r .id <<<"$app")" "$(jq -c '.same_site_cookie_attribute = "lax" | .policies |= map({id, precedence})' <<<"$app")" >/dev/null \
    || die "can't set the Access app cookie to SameSite=Lax" "Access: Apps and Policies Edit"
  echo "Access app cookie set to SameSite=Lax"
fi
