#!/usr/bin/env bash
# make down: deletes every Cloudflare resource cinder runs on, so the account is as it was before make up.
# --dry-run lists what would go. Asks you to type the account id once; CINDER_YES=1 skips that.
# Idempotent: a resource that is already gone is skipped. Kept: the Zero Trust organization, the Secrets Store store,
# the managed container registry images, Analytics Engine data (no delete API) and ~/.config/cinder/cloudflare.env.
# Needs the token make up used (cloudflare.env): the same permissions, delete included in Edit.
set -euo pipefail
cd "$(dirname "$0")/.."
conf=${CINDER_CONF:-$HOME/.config/cinder}
# shellcheck disable=SC1091
if [ -r "$conf/cloudflare.env" ]; then set -a; . "$conf/cloudflare.env"; set +a; fi
acct=${CF_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:?set CF_ACCOUNT_ID in $conf/cloudflare.env}}
tok=${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN in $conf/cloudflare.env}
base="https://api.cloudflare.com/client/v4/accounts/$acct"
cfg=worker/wrangler.jsonc
dry=; [ "${1:-}" = --dry-run ] && dry=1
bad=0

# api METHOD PATH [JSON]: prints the body; fails unless Cloudflare reports success (a missing resource is a failure).
api() {
  local out
  out=$(curl -sS -X "$1" "$base$2" -H @<(printf 'Authorization: Bearer %s\n' "$tok") -H "Content-Type: application/json" ${3:+--data "$3"}) || return 1
  jq -e .success >/dev/null 2>&1 <<<"$out" || { why=$(jq -r '[.errors[]?.message] | join("; ")' 2>/dev/null <<<"$out" | head -c 300); return 1; }
  printf '%s' "$out"
}
names() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" "$cfg" | sed 's/.*"\([^"]*\)"$/\1/' | sort -u; }
# A listing that fails is treated as empty: the resource is not there (or not readable, and the delete would fail the same way).
list() { api GET "$1" | jq -r "$2" 2>/dev/null || true; }
gone() { echo "skip    $1 (not found)"; }
# del LABEL PATH [JSON]
del() {
  if [ -n "$dry" ]; then echo "would delete $1"; return 0; fi
  why=
  if api DELETE "$2" "${3:-}" >/dev/null; then echo "deleted $1"; else echo "FAILED  $1${why:+: $why}"; bad=$((bad + 1)); return 1; fi
}
step() { printf '\n== %s\n' "$*"; }
# del_each LABEL PATH_PREFIX: reads "id name" lines
del_each() { local id name; while read -r id name; do [ -z "$id" ] || del "$1 $name" "$2/$id" || true; done; }

echo "account $acct${dry:+ (dry run)}"
if [ -z "$dry" ] && [ "${CINDER_YES:-}" != 1 ]; then
  read -rp "This deletes every cinder resource on account $acct, including its data. Type the account id to continue: " typed
  [ "$typed" = "$acct" ] || { echo "Not confirmed, nothing deleted."; exit 1; }
fi

# Artifacts first, while the Worker still exists: the REST API lists every repo, forks (<repo>--c<id>) and cinder-agents included.
step "Artifacts repos"
for ns in $(names namespace); do
  # A namespace a past teardown deleted comes back implicitly with the next make up's repos, and its own GET can still
  # answer 404 while it lists them: so its repos are listed whatever that GET says.
  repos=; cur=
  while out=$(api GET "/artifacts/namespaces/$ns/repos?limit=200${cur:+&cursor=$cur}"); do
    repos+=$(jq -r '.result[]?.name' <<<"$out")$'\n'
    cur=$(jq -r '.result_info.cursor // empty | @uri' <<<"$out")
    [ "$(jq '.result | length' <<<"$out")" -ge 200 ] && [ -n "$cur" ] || break
  done
  # 10 at a time: a long-lived install has hundreds of change forks, and one by one takes minutes.
  failed=$(mktemp); n=0
  for r in $repos; do
    { del "Artifacts repo $ns/$r" "/artifacts/namespaces/$ns/repos/$r" || echo x >> "$failed"; } &
    n=$((n + 1)); [ $((n % 10)) -ne 0 ] || wait
  done
  wait; bad=$((bad + $(wc -l < "$failed"))); rm -f "$failed"
  # Artifacts deletes asynchronously: a deleted repo still answers (with its commits) for a few minutes. Wait until the
  # namespace lists none, or the next make up's seed sees the old history, skips its import and is left with empty repos.
  if [ -z "$dry" ]; then
    for i in $(seq 1 60); do
      left=$(list "/artifacts/namespaces/$ns/repos?limit=200" '.result | length')
      [ "${left:-0}" = 0 ] && break
      [ "$i" = 1 ] && echo "waiting for Artifacts to finish deleting $left repos"
      sleep 5
    done
    [ "${left:-0}" = 0 ] || { echo "FAILED  Artifacts still lists $left repos in $ns after 5 min"; bad=$((bad + 1)); }
  fi
  [ -n "${repos//$'\n'/}" ] || gone "Artifacts repos in $ns"
  # lazy: an empty namespace is deleted when the API allows it; a refusal leaves it (it is free and implicit), not an error.
  if [ -n "$dry" ]; then echo "would delete Artifacts namespace $ns"
  elif api DELETE "/artifacts/namespaces/$ns" >/dev/null; then echo "deleted Artifacts namespace $ns"; else echo "kept    Artifacts namespace $ns (not deletable)"; fi
done

step "Container apps"
# Before the Workers: a Worker whose Durable Objects back container apps can't be deleted while the apps exist.
apps=$(list "/containers/applications?per_page=100" '.result[]? | select(.name | startswith("cinder")) | "\(.id) \(.name)"')
if [ -n "$apps" ]; then del_each "container app" /containers/applications <<<"$apps"; else gone "container apps"; fi

step "Queue consumers"
# Before the Workers: Cloudflare refuses to delete a Worker that consumes a queue, and a queue a Worker still binds.
for q in $(names queue); do
  id=$(list "/queues?per_page=100" ".result[]? | select(.queue_name == \"$q\") | .queue_id")
  [ -n "$id" ] || continue
  cons=$(list "/queues/$id/consumers" '.result[]? | "\(.consumer_id) \(.script // .script_name // "consumer")"')
  [ -z "$cons" ] || del_each "consumer of $q:" "/queues/$id/consumers" <<<"$cons"
done

step "Workers"
# cinder binds cinder-secrets, so it goes first; force drops the Durable Object classes with the script.
for w in cinder cinder-secrets; do
  if api GET "/workers/scripts/$w/settings" >/dev/null; then del "Worker $w" "/workers/scripts/$w?force=true" || true; else gone "Worker $w"; fi
done

step "Environments cinder made for the demo and seed repos (pulse, web-store)"
# worker/src/deploy.js names them <name>-<env> (env: preview, staging, production, or c<8 hex> for a change's preview).
envs='(preview|staging|production|c[0-9a-f]{8})'
for w in $(list /workers/scripts ".result[]?.id | select(test(\"^(pulse|web-store)-$envs\$\"))"); do del "Worker $w" "/workers/scripts/$w?force=true" || true; done
for id in $(list "/d1/database?per_page=100" ".result[]? | select(.name | test(\"^pulse-db-$envs\$\")) | .uuid"); do del "D1 database $id" "/d1/database/$id" || true; done
for id in $(list "/storage/kv/namespaces?per_page=100" ".result[]? | select(.title | test(\"^pulse-cache-$envs\$\")) | .id"); do del "KV namespace $id" "/storage/kv/namespaces/$id" || true; done

step "Workflows"
for wf in cinder-pipeline cinder-reset cinder-seed; do
  if api GET "/workflows/$wf" >/dev/null; then del "Workflow $wf" "/workflows/$wf" || true; else gone "Workflow $wf"; fi
done

step "Queues"
for q in $(names queue) $(names dead_letter_queue); do
  id=$(list "/queues?per_page=100" ".result[]? | select(.queue_name == \"$q\") | .queue_id")
  if [ -n "$id" ]; then del "Queue $q" "/queues/$id" || true; else gone "Queue $q"; fi
done

step "D1"
for db in $(names database_name); do
  id=$(list "/d1/database?name=$db" ".result[]? | select(.name == \"$db\") | .uuid")
  if [ -n "$id" ]; then del "D1 database $db" "/d1/database/$id" || true; else gone "D1 database $db"; fi
done

step "Vectorize"
for ix in $(names index_name); do
  if api GET "/vectorize/v2/indexes/$ix" >/dev/null; then del "Vectorize index $ix" "/vectorize/v2/indexes/$ix" || true; else gone "Vectorize index $ix"; fi
done

step "R2"
for b in $(names bucket_name); do
  if [ -z "$(list "/r2/buckets?name_contains=$b" ".result.buckets[]? | select(.name == \"$b\") | .name")" ]; then gone "R2 bucket $b"; continue; fi
  if [ -n "$dry" ]; then echo "would empty and delete R2 bucket $b"; continue; fi
  # R2 refuses to delete a bucket with objects: delete them 1000 at a time.
  emptied=0
  while keys=$(api GET "/r2/buckets/$b/objects?per_page=1000" | jq -c '[.result[]?.key]') && [ "$keys" != '[]' ]; do
    api DELETE "/r2/buckets/$b/objects" "$keys" >/dev/null || { echo "FAILED  emptying R2 bucket $b"; bad=$((bad + 1)); break; }
    emptied=$((emptied + $(jq length <<<"$keys")))
  done
  echo "emptied R2 bucket $b ($emptied objects)"
  del "R2 bucket $b" "/r2/buckets/$b" || true
done

step "AI Gateway"
if api GET /ai-gateway/gateways/cinder >/dev/null; then
  for id in $(list /ai-gateway/gateways/cinder/provider_configs '.result[]?.id'); do del "AI Gateway provider config $id" "/ai-gateway/gateways/cinder/provider_configs/$id" || true; done
  del "AI Gateway cinder" /ai-gateway/gateways/cinder || true
else gone "AI Gateway cinder"; fi

step "Secrets Store secrets (the store stays)"
found=0
for store in $(list /secrets_store/stores '.result[]?.id'); do
  # Deleting shifts the pages, so the first page is listed again until no cinder_ secret is left (one pass in a dry run).
  while ids=$(list "/secrets_store/stores/$store/secrets?per_page=100" '.result[]? | select(.name | startswith("cinder_")) | "\(.id) \(.name)"') && [ -n "$ids" ]; do
    found=1; before=$bad
    del_each "secret" "/secrets_store/stores/$store/secrets" <<<"$ids"
    [ -z "$dry" ] && [ "$bad" = "$before" ] || break
  done
done
[ "$found" = 1 ] || gone "cinder secrets"

step "Access"
apps=$(list /access/apps '.result[]? | select(.name == "cinder") | "\(.id) \(.domain)"')
if [ -n "$apps" ]; then del_each "Access app" /access/apps <<<"$apps"; else gone "Access app cinder"; fi
toks=$(list /access/service_tokens '.result[]? | select(.name == "cinder-runners") | "\(.id) cinder-runners"')
if [ -n "$toks" ]; then del_each "Access service token" /access/service_tokens <<<"$toks"; else gone "Access service token cinder-runners"; fi

step "Local files"
for f in live.env access.env; do
  if [ -n "$dry" ]; then [ ! -e "$conf/$f" ] || echo "would remove $conf/$f"
  elif [ -e "$conf/$f" ]; then rm "$conf/$f"; echo "removed $conf/$f"; else gone "$conf/$f"; fi
done

if [ "$bad" -gt 0 ]; then echo; echo "$bad deletions failed: fix the cause above and re-run make down."; exit 1; fi
echo; echo "${dry:+dry run, nothing deleted}${dry:-cinder is gone from account $acct}"
