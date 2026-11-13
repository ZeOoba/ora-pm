#!/usr/bin/env bash
# Runs a command up to RETRY_ATTEMPTS times (default 3), RETRY_DELAY seconds apart (default 30),
# retrying ONLY when its output shows a transient upstream failure (an HTTP 5xx, a connection
# reset, a non-JSON API reply). Any other failure (bad token, missing env var, build error) fails
# at once. Output is passed through unchanged. Used by .github/workflows/ci.yml around the
# Cloudflare steps after a 503 outage on 2026-11-13 left four merges undeployed.
#
# Usage: scripts/retry-transient.sh <command> [args...]
set -uo pipefail
attempts="${RETRY_ATTEMPTS:-3}"
delay="${RETRY_DELAY:-30}"
transient='(\b5[0-9][0-9] [A-Z][A-Za-z ]+\b|-> 5[0-9][0-9]\b|malformed response|upstream connect error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|Cloudflare API request failed \(SyntaxError\))'
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
for ((i = 1; i <= attempts; i++)); do
  "$@" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  [ "$status" -eq 0 ] && exit 0
  if ! grep -Eq "$transient" "$log"; then
    exit "$status"
  fi
  if [ "$i" -lt "$attempts" ]; then
    echo "::warning::transient upstream failure (attempt $i/$attempts); retrying in ${delay}s"
    sleep "$delay"
  fi
done
echo "::error::still failing after $attempts attempts (transient upstream failure)"
exit "$status"
