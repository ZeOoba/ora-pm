#!/usr/bin/env bash
# Tests for scripts/delinquency-backup.sh (OI-229). No network: CURL_BIN points
# at a stub that prints a canned body + HTTP code, exactly as `curl -w '\n%{http_code}'`.
# Run: bash scripts/delinquency-backup.test.sh   (exit 0 = all pass)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fails=0

stub() { # $1 body, $2 http code, $3 curl exit code
  cat > "$tmp/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n%s' '$1' '$2'
exit ${3:-0}
EOF
  chmod +x "$tmp/curl"
}

expect() { # $1 name, $2 expected exit (0|nonzero), $3 secret
  out=$(CURL_BIN="$tmp/curl" CRON_SECRET="$3" BASE_URL="https://example.invalid" bash "$here/delinquency-backup.sh" 2>&1); rc=$?
  if { [ "$2" = 0 ] && [ "$rc" -eq 0 ]; } || { [ "$2" = nonzero ] && [ "$rc" -ne 0 ]; }; then
    echo "PASS $1"
  else
    echo "FAIL $1 (rc=$rc)"; echo "$out" | sed 's/^/    /'; fails=$((fails+1))
  fi
}

stub '{"late_fees_posted":0,"delinquent_count":68,"email":{"subject":"s","body":"b"}}' 200
expect "laptop-already-ran posts 0 -> success" 0 secret

stub '{"late_fees_posted":33,"delinquent_count":68,"email":{"subject":"s","body":"b"}}' 200
expect "laptop-missed posts fees -> success" 0 secret

stub '{"late_fees_posted":0,"delinquent_count":0,"email":null}' 200
expect "no AR rows -> success" 0 secret

stub '{"late_fees_posted":0,"delinquent_count":68}' 200
expect "missing secret refuses to run" nonzero ""

stub '{}' 200
expect "empty 2xx object is a failure, not a zero" nonzero secret

stub '{"late_fees_posted":"3","delinquent_count":68}' 200
expect "non-numeric counter is a failure" nonzero secret

stub '{"late_fees_posted":1e400,"delinquent_count":68}' 200
expect "non-finite counter is a failure" nonzero secret

stub '<html>login</html>' 200
expect "non-JSON 2xx is a failure" nonzero secret

stub '{"error":"boom"}' 500
expect "HTTP 500 is a failure" nonzero secret

stub '{"error":"Too many cron requests"}' 429
expect "HTTP 429 is a failure" nonzero secret

stub '' 000 28
expect "curl transport error is a failure" nonzero secret

# The digest body lists tenant names + balances; the job log must never echo it.
stub '{"late_fees_posted":1,"delinquent_count":1,"email":{"subject":"s","body":"TENANT_PII_MARKER"}}' 200
out=$(CURL_BIN="$tmp/curl" CRON_SECRET=secret BASE_URL="https://example.invalid" bash "$here/delinquency-backup.sh" 2>&1)
if printf '%s' "$out" | grep -q TENANT_PII_MARKER; then echo "FAIL digest body leaked to log"; fails=$((fails+1)); else echo "PASS digest body not logged"; fi

stub '{"error":"TENANT_PII_MARKER"}' 500
out=$(CURL_BIN="$tmp/curl" CRON_SECRET=secret BASE_URL="https://example.invalid" bash "$here/delinquency-backup.sh" 2>&1)
if printf '%s' "$out" | grep -q TENANT_PII_MARKER; then echo "FAIL error body leaked to log"; fails=$((fails+1)); else echo "PASS error body not logged"; fi

echo "---"; [ "$fails" -eq 0 ] && echo "ALL PASS" || echo "$fails FAILED"
exit "$fails"
