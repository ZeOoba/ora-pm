#!/usr/bin/env bash
# Off-host backup trigger for POST /api/cron/delinquency-check (OI-229).
# Invoked by .github/workflows/delinquency-backup.yml; tested by
# scripts/delinquency-backup.test.sh (CURL_BIN stub, no network).
#
# Safe to double-fire: the endpoint posts at most one late fee per lease per
# month (existing-fee guard + unique idempotency_key late_fee_<lease>_<YYYY>_<MM>),
# so after the laptop's ping-crons.ps1 run this posts 0.
#
# Deliberately does NOT call /api/cron/critical-dates-alerts (or its /ack):
# only ping-crons.ps1 (Outlook COM, the sole send path) can deliver that
# digest, and only a confirmed send may ack it (OI-321). This job has no send
# path, so an ack from here would mark alerts sent that nobody ever received.
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
  *)
    echo "::error::delinquency-check -> HTTP $code (body withheld: may contain tenant data)"
    # The body stays withheld, but a Cloudflare 1xxx code inside it is not tenant
    # data, so print that 4-digit code and never the rest of the body. Name a
    # cause only when the evidence supports one: a 1016 inside the app's own JSON
    # error means the Worker ran and a Supabase call came back with Cloudflare's
    # origin DNS error, i.e. the SUPABASE_URL host stopped resolving, which is
    # what a PAUSED free-plan project looks like. A raw code (no JSON wrapper) can
    # come from the edge or from the ora-pm Worker itself (1101 = it threw), so it
    # is reported with no layer claimed. The 2026-10-12 pause was logged only as
    # "HTTP 500": on the laptop from 10-13, here from 11-01 (GitHub billing
    # blocked this job until 10-31). Here-strings, not pipes, feed `grep -q` so
    # pipefail cannot turn an early-exit match into a miss; `|| true` keeps
    # grep's no-match status out of this branch, which always exits 1.
    if grep -qE '"error" *: *"[^"]*error code: 1016([^0-9.]|$)' <<< "$body"; then
      echo "::error::Cloudflare error 1016 (origin DNS error) on the Worker's Supabase calls: the host in the Pages SUPABASE_URL secret does not resolve. Most likely the Supabase project is PAUSED (the free plan pauses a project after 7 days without activity). Restore it from the Supabase dashboard, then re-run this workflow."
    else
      cf=$(grep -oE 'error code: 1[0-9]{3}([^0-9.]|$)' <<< "$body" | head -n1 | grep -oE '1[0-9]{3}' || true)
      if [ -n "$cf" ]; then
        echo "::error::Cloudflare error $cf in the response: an edge or Worker-runtime error, and the failing layer is not identified (a raw code can come from the ora-pm Worker itself, e.g. 1101 when it throws). Check the Pages Functions log and the Supabase project status."
      fi
    fi
    exit 1 ;;
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
