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

# A Cloudflare 1xxx code inside an error body is not tenant data, so the script
# prints that 4-digit code and nothing else from the body. It names a cause only
# when the evidence supports one. A 1016 INSIDE the app's own JSON error
# ({"error":"..."}) means the Worker ran and a Supabase call came back with
# Cloudflare's origin DNS error: the project host stopped resolving, which is
# what a PAUSED free-plan project looks like (from 2026-10-12 both cron routes
# returned HTTP 500 {"error":"error code: 1016\n"} for weeks). A raw code with
# no JSON wrapper can come from the edge or from the ora-pm Worker itself (1101
# = the Worker threw), so it is reported with no layer claimed.
run() { CURL_BIN="$tmp/curl" CRON_SECRET=secret BASE_URL="https://example.invalid" bash "$here/delinquency-backup.sh" 2>&1; }
verdict() { # $1 name, $2 "ok" or empty; reads $out
  if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; echo "$out" | sed 's/^/    /'; fails=$((fails+1)); fi
}
# A no-cause message names the code and blames neither a pause nor the database.
generic_ok() { printf '%s' "$out" | grep -q "Cloudflare error $1" && ! printf '%s' "$out" | grep -qiE 'paused|database upstream'; }

stub '{"error":"error code: 1016\n"}' 500
out=$(run); rc=$?; ok=""
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'Cloudflare error 1016' && printf '%s' "$out" | grep -qi 'paused' && ok=ok
verdict "1016 in the app's JSON error fails and names the paused-Supabase cause" "$ok"

stub '{"error":"recent-charges: error code: 1016 TENANT_PII_MARKER"}' 500
out=$(run); ok=""
printf '%s' "$out" | grep -q 'Cloudflare error 1016' && ! printf '%s' "$out" | grep -q TENANT_PII_MARKER && ok=ok
verdict "1016 diagnosis prints the code, never the rest of the body" "$ok"

stub '{"error":"error code: 1020; then error code: 1016\n"}' 500
out=$(run); ok=""
printf '%s' "$out" | grep -qi 'paused' && ok=ok
verdict "a wrapped 1016 wins over an earlier code in the same body" "$ok"

stub '{"error":"error code: 1020"}' 502
out=$(run); rc=$?; ok=""
[ "$rc" -ne 0 ] && generic_ok 1020 && ok=ok
verdict "another wrapped 1xxx code is named with no cause claimed" "$ok"

stub 'error code: 1101' 500
out=$(run); rc=$?; ok=""
[ "$rc" -ne 0 ] && generic_ok 1101 && ok=ok
verdict "a raw 1101 (the Worker itself threw) is not blamed on the database" "$ok"

stub 'error code: 1016' 530
out=$(run); rc=$?; ok=""
[ "$rc" -ne 0 ] && generic_ok 1016 && ok=ok
verdict "a raw 1016 ending the body is named, with no paused claim" "$ok"

stub '{"error":"error code: 10160"}' 500
out=$(run); rc=$?; ok=""
[ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q 'Cloudflare error' && ok=ok
verdict "a 5-digit number is not read as a Cloudflare code" "$ok"

stub '{"error":"error code: 1016.5"}' 500
out=$(run); rc=$?; ok=""
[ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q 'Cloudflare error' && ok=ok
verdict "a decimal is not read as a Cloudflare code" "$ok"

stub '{"error":"boom"}' 500
out=$(run); rc=$?; ok=""
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'body withheld' && ! printf '%s' "$out" | grep -q 'Cloudflare error' && ok=ok
verdict "plain HTTP 500 keeps the withheld-body message, no Cloudflare claim" "$ok"

echo "---"; [ "$fails" -eq 0 ] && echo "ALL PASS" || echo "$fails FAILED"
exit "$fails"
