#!/usr/bin/env bash
# Stands cinder up on Cloudflare. Safe to re-run: every step checks before it creates.
# Auth (headless): ~/.config/cinder/cloudflare.env with CLOUDFLARE_API_TOKEN=... and CF_ACCOUNT_ID=... (wrangler reads the token
# from the environment). A browser `wrangler login` also works where a browser can reach this machine.
# Optional in the same file: CF_DEPLOY_TOKEN=... (narrower deploy token for the pipeline; defaults to CLOUDFLARE_API_TOKEN).
set -euo pipefail
cd "$(dirname "$0")/.."
conf=${CINDER_CONF:-$HOME/.config/cinder}
mkdir -p "$conf" && chmod 700 "$conf"
# shellcheck disable=SC1091
if [ -r "$conf/cloudflare.env" ]; then set -a; . "$conf/cloudflare.env"; set +a; fi
w() { npx --prefix worker wrangler --cwd worker "$@"; }
# A Worker secret write can hit a transient Cloudflare 500 ("internal authentication error"): up to 3 tries.
sput() { local v; v=$(cat); for i in 1 2 3; do printf '%s' "$v" | w secret put "$1" >/dev/null && return 0; [ "$i" = 3 ] || { echo "secret $1: retrying"; sleep 5; }; done; return 1; }
step() { printf '\n== %s\n' "$*"; }

# A fresh clone has no node_modules: install the lockfile's packages so wrangler and vite are the pinned ones.
[ -d node_modules ] || { step "install packages"; npm ci --no-audit --no-fund; }

step "login"
who=$(w whoami 2>&1) || true
if grep -qi 'not logged in\|not authenticated' <<<"$who"; then
  echo "Not authenticated. Put CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID in $conf/cloudflare.env (or run wrangler login where a browser can reach this machine)"; exit 2
fi
acct=${CF_ACCOUNT_ID:-$(grep -oE '\b[0-9a-f]{32}\b' <<<"$who" | head -1 || true)}
[ -n "$acct" ] || { echo "Couldn't read the account id; set CF_ACCOUNT_ID in $conf/cloudflare.env"; exit 2; }
echo "account $acct"

step "resources (AI Gateway, D1, queues, R2, Artifacts) and the deploy config ids"
tok=${CLOUDFLARE_API_TOKEN:-$(grep -oE '^oauth_token *= *"[^"]+"' "$HOME/.config/.wrangler/config/default.toml" 2>/dev/null | sed 's/.*"\(.*\)"/\1/')}
CLOUDFLARE_API_TOKEN=$tok CF_ACCOUNT_ID=$acct deploy/reconcile.sh

step "secrets"
[ -s "$conf/owner-token" ] || { openssl rand -hex 32 > "$conf/owner-token"; chmod 600 "$conf/owner-token"; }
sput OWNER_TOKEN < "$conf/owner-token"
# Keystore values live in Secrets Store now: the old AES key goes.
if w secret list 2>/dev/null | grep -q '"KEYSTORE_KEY"'; then w secret delete KEYSTORE_KEY >/dev/null; echo "KEYSTORE_KEY deleted"; fi
dt=${CF_DEPLOY_TOKEN:-${CLOUDFLARE_API_TOKEN:-}} # the same token unless a narrower deploy token is set in cloudflare.env
if [ -n "$dt" ]; then printf '%s' "$dt" | sput CF_DEPLOY_TOKEN; echo "CF_DEPLOY_TOKEN set"
else echo "CF_DEPLOY_TOKEN not set: no API token in the environment (browser login); deploys to the demo app stay off until CLOUDFLARE_API_TOKEN is in $conf/cloudflare.env"; fi

step "migrations"
# A fresh database gets every migration in one batch, each recorded in wrangler's d1_migrations table exactly as
# `migrations apply` records it (same schema, ~150 files in seconds instead of ~13 min one request at a time).
# A database with migrations already applied takes the normal incremental apply.
applied=$(w d1 execute cinder --remote --json --command "SELECT COUNT(*) AS n FROM d1_migrations" 2>/dev/null | jq -r '.[0].results[0].n // 0' 2>/dev/null || echo 0)
if [ "${applied:-0}" = 0 ]; then
  all=$(mktemp --suffix .sql)
  { echo "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);"
    for f in $(ls worker/migrations/*.sql | sort); do cat "$f"; echo; echo "INSERT INTO d1_migrations (name) VALUES ('$(basename "$f")');"; done; } > "$all"
  w d1 execute cinder --remote --file "$all" -y >/dev/null && echo "fresh database: $(ls worker/migrations/*.sql | wc -l) migrations applied in one batch"
  rm -f "$all"
fi
w d1 migrations apply cinder --remote

step "build and deploy"
npm run build -w web
npx --prefix worker wrangler --cwd worker/secrets deploy # cinder-secrets first: cinder's SECRETS binding points to it
# The first deploy after make down recreates the container apps and can fail transiently: one retry, and a failure prints why.
out=$(w deploy 2>&1) || { echo "$out" | tail -20; echo "deploy failed; retrying once"; out=$(w deploy 2>&1) || { echo "$out" | tail -40; exit 1; }; }
echo "$out" | tail -5
url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$out" | head -1)

step "health"
curl -fsS "$url/api/health" && echo
printf 'CINDER_URL=%s\nCINDER_TOKEN=%s\nCINDER_AI_GATEWAY=%s\n' "$url" "$(cat "$conf/owner-token")" "https://gateway.ai.cloudflare.com/v1/$acct/cinder" > "$conf/live.env"; chmod 600 "$conf/live.env"
echo "live at $url (CLI and runner settings in $conf/live.env)"
