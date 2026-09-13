#!/usr/bin/env bash
# Off-host backup trigger for POST /api/cron/delinquency-check (OI-229).
# Invoked by .github/workflows/delinquency-backup.yml; tested by
# scripts/delinquency-backup.test.sh (CURL_BIN stub, no network).
#
# Safe to double-fire: the endpoint posts at most one late fee per lease per
# month (existing-fee guard + unique idempotency_key late_fee_<lease>_<YYYY>_<MM>),
# so after the laptop's ping-crons.ps1 run this posts 0.
#
# Deliberately does NOT call /api/cron/critical-dates-alerts: that endpoint
# writes sent_notifications dedup rows BEFORE returning its digest, and only
# ping-crons.ps1 (Outlook COM, the sole send path) can deliver it. A backup
# call there would mark alerts sent that nobody ever receives.
#
# The response `email` field (tenant names + balances) is never printed — the
# job log is readable by every repo collaborator. Only the two counters are.
set -uo pipefail

: "${BASE_URL:=https://ora-pm.pages.dev}"
: "${CURL_BIN:=curl}"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "::error::ORA_PM_CRON_SECRET repo secret is not set -- refusing to run"
  exit 1
fi

# 280s: the endpoint's 68-row run once exceeded a 240s client timeout (cron.ts
# 2026-08-17 note); a client-side cancel does not stop the Worker, so a timeout
# here is reported as a failure, not assumed to have posted nothing.
resp=$("$CURL_BIN" -sS --max-time 280 -X POST "${BASE_URL}/api/cron/delinquency-check" \
         -H "Authorization: Bearer ${CRON_SECRET}" \
         -H "Content-Type: application/json" \
         -w '\n%{http_code}') || { echo "::error::curl transport failure (exit $?) -- outcome unknown, check the Worker log"; exit 1; }

code=$(printf '%s' "$resp" | tail -n1)
body=$(printf '%s' "$resp" | sed '$d')

case "$code" in
  2[0-9][0-9]) ;;
  *) echo "::error::delinquency-check -> HTTP $code (body withheld: may contain tenant data)"; exit 1 ;;
esac

# Strict shape check: both counters present AND numeric. A 2xx that is not the
# documented shape (login page, `{}`, renamed field) is a FAILURE -- this job
# posts late fees and must never report success on a response it cannot read.
counters=$(printf '%s' "$body" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let j; try { j = JSON.parse(s) } catch { process.exit(1) }
    if (j === null || typeof j !== "object" ||
        !Number.isFinite(j.late_fees_posted) || !Number.isFinite(j.delinquent_count)) process.exit(1)
    process.stdout.write(`late_fees_posted=${j.late_fees_posted} delinquent_count=${j.delinquent_count}`)
  })') || { echo "::error::delinquency-check -> HTTP $code but body is not the response shape (need numeric late_fees_posted/delinquent_count)"; exit 1; }

echo "delinquency-check: HTTP $code $counters"
