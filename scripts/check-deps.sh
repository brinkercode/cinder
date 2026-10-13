#!/usr/bin/env bash
# Fails when a package.json or go.mod names a dependency that deps-allow.txt doesn't list.
set -euo pipefail
cd "$(dirname "$0")/.."
allowed=$(grep -v '^#' deps-allow.txt | sed '/^$/d' | sort -u)
used=$( { for f in package.json worker/package.json web/package.json; do jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' "$f"; done
          (cd runner && go list -m -f '{{if not .Main}}{{.Path}}{{end}}' all 2>/dev/null | sed '/^$/d' || true); } | sort -u)
missing=$(comm -23 <(echo "$used") <(echo "$allowed"))
if [ -n "$missing" ]; then
  echo "unapproved dependencies (owner must add to deps-allow.txt):" >&2
  echo "$missing" >&2
  exit 1
fi
