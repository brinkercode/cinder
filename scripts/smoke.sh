#!/usr/bin/env bash
# make smoke: proves a deployed cinder works end to end, through its API and plain git only (credentials from make up).
# Prints PASS or FAIL with one line of evidence per check, then a summary; exits 1 when any check failed. Closes its throwaway changes.
# CINDER_URL, CINDER_TOKEN (and the Access service token) come from the environment or ~/.config/cinder/live.env.
# SMOKE_VERIFY_TIMEOUT (default 900 s) is how long verify and the merge may wait for a worker; SMOKE_AGENT_TIMEOUT (default 900) for the agent changes.
set -uo pipefail
conf=${CINDER_CONF:-$HOME/.config/cinder}
if [ -z "${CINDER_URL:-}" ]; then set -a; . "$conf/live.env"; [ ! -r "$conf/access.env" ] || . "$conf/access.env"; set +a; fi
: "${CINDER_URL:?}" "${CINDER_TOKEN:?}"
vt=${SMOKE_VERIFY_TIMEOUT:-900} at=${SMOKE_AGENT_TIMEOUT:-900}
R=svc-orders-go T=main
# curl reads the headers from a process substitution (-H @<(hdr)) so the tokens never show in the process list.
hdr() {
  printf 'Authorization: Bearer %s\n' "$CINDER_TOKEN"
  [ -z "${CINDER_ACCESS_CLIENT_ID:-}" ] || printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$CINDER_ACCESS_CLIENT_ID" "$CINDER_ACCESS_CLIENT_SECRET"
}
api() { curl -sS --max-time 60 -H @<(hdr) -H "content-type: application/json" "$@"; }
t0=$(date +%s); passed=0 failed=0
W=$(mktemp -d); mine=()
cleanup() { for c in "${mine[@]}"; do api -X POST "$CINDER_URL/api/changes/$c/close" -d '{"reason":"smoke test"}' -o /dev/null; done; rm -rf "$W"; }
trap cleanup EXIT
# ok NAME EVIDENCE (pass) / bad NAME EVIDENCE (fail)
ok() { passed=$((passed + 1)); printf 'PASS  %-34s %s [+%ss]\n' "$1" "$2" $(($(date +%s) - t0)); }
bad() { failed=$((failed + 1)); printf 'FAIL  %-34s %s [+%ss]\n' "$1" "$2" $(($(date +%s) - t0)); }
state() { api "$CINDER_URL/api/changes/$1" | jq -r '.state // "unknown"'; }
codes() { api "$CINDER_URL/api/changes/$1" | jq -c '[.blockers[]?.code]'; }
checks() { api "$CINDER_URL/api/changes/$1/checks" | jq -c '[.[] | "\(.kind):\(.status)"]'; }
# until SECONDS CMD...: polls CMD every 10 s until it succeeds
until_ok() { local end=$((SECONDS + $1)); shift; while ! "$@"; do [ "$SECONDS" -lt "$end" ] || return 1; sleep 10; done; }

# --- 1. sign-in and health
health=$(curl -sS --max-time 30 -H @<(hdr) "$CINDER_URL/api/health" -w ' http=%{http_code}')
me=$(api -w ' http=%{http_code}' "$CINDER_URL/api/me")
if [[ $health == *http=200 && $me == *http=200 ]]; then ok "sign-in and API health" "health ${health%% http*}, me $(jq -rc '.email // .person // .name // "ok"' <<<"${me% http=*}" 2>/dev/null)"
else bad "sign-in and API health" "health: ${health:0:80}; me: ${me:0:80}"; fi

# --- 2. seed repos and branches
repos=$(api "$CINDER_URL/api/repos" | jq -r '(if type=="array" then . else .repos end)[]?.name' | sort | tr '\n' ' ')
branches() { api "$CINDER_URL/api/repos/$1/branches" | jq -r '(if type=="array" then . else .branches end)[]? | (.name // .)' | sort | tr '\n' ' '; }
missing=
for r in web-store svc-orders-go infra-cloudflare-tf; do [[ $repos == *"$r "* ]] || missing+=" $r"; done
wb=$(branches web-store)
if [ -z "$missing" ] && [[ $wb == *"develop "* && $wb == *"main "* ]] && [[ $(branches $R) == *"main "* ]]; then ok "seed repos and branches" "web-store: $wb"
else bad "seed repos and branches" "missing:${missing:- none}; web-store branches: ${wb:-none}"; fi

# --- git: one credential per push (the token is a bearer header; it contains '?', so it can't sit in a URL)
cred() { api -X POST "$CINDER_URL/api/repos/$R/git-credentials" -d '{}'; }
c=$(cred); url=$(jq -r .remote <<<"$c")
export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=smoke@cinder.invalid GIT_CONFIG_KEY_2=http.extraHeader
fresh() { export GIT_CONFIG_VALUE_2="Authorization: Bearer $(cred | jq -r .token)"; }
fresh
git clone -q "$url" "$W/repo" 2>"$W/clone.err" && cd "$W/repo" || { bad "git clone" "$(head -c 150 "$W/clone.err")"; echo; echo "SUMMARY: $passed passed, $failed failed"; exit 1; }
find_change() { # $1 title → id, once the push has opened it
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    id=$(api "$CINDER_URL/api/repos/$R/changes" | jq -r --arg t "$1" '(if type=="array" then . else .changes end)[]? | select(.title == $t) | .id' | head -1)
    [ -z "$id" ] || { echo "$id"; return 0; }; sleep 5
  done; return 1
}
push_change() { # $1 branch, $2 file, $3 line, $4 subject → prints the change id; the push output goes to $W/push.out
  fresh; git fetch -q origin "$T" && git switch -q -C "$1" "origin/$T" || return 1
  printf '%s\n' "$3" >> "$2"; git add -A; git -c user.name=smoke commit -q -m "$4"
  git push origin "HEAD:refs/for/$T" >"$W/push.out" 2>&1 || return 1
  find_change "$4"
}
stamp=$(date -u +%H%M%S)
# Each judge's recorded judgments and fallbacks before this run, to compare with after (section 9).
# recent lists the judge's latest judgments (newest first, each with Clef's probability); count is only the scored ones.
judges() { api "$CINDER_URL/api/repos/$R/judges" | jq -c '[.judges[]? | {key: .kind, value: {n: (.recent | length), top: .recent[0], fallbacks}}] | from_entries'; }
before=$(judges)

# Agent changes first: they take minutes, the git checks run beside them.
agents=()
# Three intents that touch nothing in common (each writes its own new file), so they run side by side, not stacked.
topics=("how an order is created" "how an order is deleted" "how the service is tested")
for i in 1 2 3; do
  id=$(api -X POST "$CINDER_URL/api/repos/$R/changes" -d "$(jq -nc --arg i "Smoke $stamp-$i: add docs/smoke-$stamp-$i.md with one short paragraph on ${topics[$((i - 1))]}" --arg t "$T" '{intent: $i, target_branch: $t}')" | jq -r '.id // empty')
  [ -z "$id" ] || { agents+=("$id"); mine+=("$id"); }
done

# --- 3. a plain git push to refs/for opens a change (titled by its commit subject)
# Its own new file, so no open change can conflict with it.
subject="Smoke $stamp: add a smoke note"
A=$(push_change smoke-clean "SMOKE-$stamp.md" "Smoke run $stamp." "$subject") && [ -n "$A" ] && mine+=("$A")
if [ -n "${A:-}" ]; then ok "git push to refs/for opens a change" "change $A titled \"$subject\""
else bad "git push to refs/for opens a change" "no change titled \"$subject\"; push said: $(tail -c 200 "$W/push.out" 2>/dev/null)"; fi

# --- 4. the guard passes; a planted fake key on a second change is quarantined
if [ -n "${A:-}" ]; then
  guard_clear() { [ "$(api "$CINDER_URL/api/changes/$A" | jq -r '.guard.status // ""')" = clear ]; }
  if until_ok 180 guard_clear; then ok "guard passes on the clean change" "guard clear"; else bad "guard passes on the clean change" "guard.status=$(api "$CINDER_URL/api/changes/$A" | jq -r '.guard.status // "none"') checks $(checks "$A")"; fi
else bad "guard passes on the clean change" "no change"; fi
cd "$W/repo" || exit 1
B=$(push_change smoke-secret config.go 'const stripeKey = "sk_live_51Hsmoke0000000000000000000000000000PLANTED"' "Smoke $stamp: planted test secret") && [ -n "$B" ] && mine+=("$B")
quarantined() { [ "$(api "$CINDER_URL/api/changes/$B" | jq -r '.guard.status // ""')" = quarantined ]; }
if [ -n "${B:-}" ] && until_ok 180 quarantined; then ok "planted sk_live_ key is quarantined" "change $B guard quarantined: $(api "$CINDER_URL/api/changes/$B" | jq -r '.guard.reason // ""' | head -c 100)"
else bad "planted sk_live_ key is quarantined" "change ${B:-none} guard=$([ -n "${B:-}" ] && api "$CINDER_URL/api/changes/$B" | jq -r '.guard.status // "none"')"; fi

# --- 5. verify passes on the merged tree (an untrusted risk judge then hands it to the reviewer agent)
if [ -n "${A:-}" ]; then
  settled() { local s; s=$(state "$A"); [[ $s =~ ^(needs_fix|failed|conflict|merged|closed)$ ]] || [[ $(codes "$A") =~ ^(\[\]|\[\"approval_missing\"\])$ && $(checks "$A") == *verify:pass* ]]; }
  until_ok "$vt" settled; s=$(state "$A")
  if [[ $(checks "$A") == *verify:pass* && ! $s =~ ^(needs_fix|failed|conflict)$ ]]; then ok "verify passes" "state $s, checks $(checks "$A"), blockers $(codes "$A")"
  else bad "verify passes" "state $s, checks $(checks "$A"), blockers $(codes "$A")"; fi
else bad "verify passes" "no change"; fi

# --- 6. merged with no person: the reviewer agent's pass queues it and a pool merges it
if [ -n "${A:-}" ]; then
  merged() { [[ $(state "$A") =~ ^(merged|needs_fix|failed|conflict)$ ]]; }
  until_ok "$vt" merged
  if [ "$(state "$A")" = merged ]; then ok "merged with no person" "state merged, route $(api "$CINDER_URL/api/changes/$A" | jq -r '.review.route // "none"')"
  else bad "merged with no person" "state $(state "$A"), blockers $(codes "$A")"; fi
else bad "merged with no person" "no change"; fi

# --- 7. the merge commit's trailers and refs/cinder/changes/<id>
if [ -n "${A:-}" ] && [ "$(state "$A")" = merged ]; then
  # The history job writes refs/cinder/changes/<id> just after the merge: poll for it.
  # The history job writes refs/cinder/changes/<id> just after the merge, and a fresh read of the branch can lag: poll for both.
  history_ref() { fresh; git fetch -q origin "+$T:refs/remotes/origin/$T" '+refs/cinder/changes/*:refs/cinder/changes/*' 2>"$W/fetch.err"
    ref=$(git for-each-ref --format='%(refname)' refs/cinder | grep -F "$A" | head -1)
    trailers=$(git log "origin/$T" -50 --grep "Cinder-Change: $A" --format='%(trailers:only)'); [ -n "$ref" ] && [ -n "$trailers" ]; }
  until_ok 180 history_ref
  files=$([ -z "$ref" ] || git ls-tree -r --name-only "$ref" | tr '\n' ' ')
  if [[ $trailers == *Cinder-Change:* && $trailers == *Cinder-Agent:* && $files == *intent.md* && $files == *judgments.jsonl* ]]; then ok "merge trailers and change ref" "$(tr '\n' ' ' <<<"$trailers" | head -c 120); $ref has $files"
  else bad "merge trailers and change ref" "trailers: ${trailers:-none}; ref: ${ref:-none} files: ${files:-none} $(head -c 100 "$W/fetch.err")"; fi
else bad "merge trailers and change ref" "change did not merge"; fi

# --- 8. agent changes (Workers AI) reach verifying, several claimed concurrently
started_re='^(developing|converging|verifying|in_queue|resolving|merged|needs_fix)$'
nstarted() { n=0; for c in "${agents[@]}"; do [[ $(state "$c") =~ $started_re ]] && n=$((n + 1)); done; echo "$n"; }
reached() { for c in "${agents[@]}"; do [[ $(state "$c") =~ ^(verifying|in_queue|merged)$ ]] && return 0; done; return 1; }
peak=0
end=$((SECONDS + at))
until reached || [ "$SECONDS" -ge "$end" ]; do n=$(nstarted); [ "$n" -le "$peak" ] || peak=$n; sleep 10; done
n=$(nstarted); [ "$n" -le "$peak" ] || peak=$n
states=$(for c in "${agents[@]}"; do state "$c"; done | tr '\n' ' ')
if [ "${#agents[@]}" -gt 0 ] && reached; then ok "agent change reaches verifying" "states: $states"; else bad "agent change reaches verifying" "${#agents[@]} created, states: ${states:-none}"; fi
if [ "$peak" -ge 2 ]; then ok "several agent changes claimed at once" "peak $peak of ${#agents[@]} started"; else bad "several agent changes claimed at once" "peak $peak of ${#agents[@]} started"; fi

# --- 9. Clef judgments: the lease (the agents' intents) and risk (the routed changes) judges recorded new answers from Clef
# A new judgment is a newest entry that wasn't there before, with a probability from Clef.
grew() { local now; now=$(judges); jq -e -n --argjson b "$before" --argjson a "$now" '[("lease","risk") as $k | ($a[$k].top != null and $a[$k].top.p != null and $a[$k].top != $b[$k].top)] | all' >/dev/null; }
until_ok 180 grew; after=$(judges)
summary=$(jq -r -n --argjson b "$before" --argjson a "$after" '[("lease","risk") as $k | "\($k): newest p=\($a[$k].top.p // "none") (fallbacks +\($a[$k].fallbacks - $b[$k].fallbacks))"] | join(", ")')
if grew; then ok "Clef judgments recorded" "$summary"; else bad "Clef judgments recorded" "$summary; a fallback means the Clef call failed"; fi

# --- 10. a later push to refs/for/<branch> is accepted
D=$(push_change smoke-again README.md "<!-- smoke $stamp -->" "Smoke $stamp: second push") && [ -n "$D" ] && mine+=("$D")
if [ -n "${D:-}" ]; then ok "second push to refs/for is accepted" "change $D opened"; else bad "second push to refs/for is accepted" "push said: $(tail -c 200 "$W/push.out" 2>/dev/null)"; fi

echo; echo "SUMMARY: $passed passed, $failed failed, $(($(date +%s) - t0))s"
[ "$failed" = 0 ]
