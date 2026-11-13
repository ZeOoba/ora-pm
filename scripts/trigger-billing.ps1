# Trigger monthly billing — run on 1st of month
# Usage: .\trigger-billing.ps1 [-Secret "your-secret"] [-BaseUrl "https://pm.oxfordra.net"]
#
# OI-162/#1 round 3 (2026-08-16): the endpoint now bounds autopay debit processing to
# AUTOPAY_BATCH_LIMIT leases per call and reports how many are still unprocessed as `remaining` —
# this script must drain it (round-2 review finding: `remaining` had no consumer, which would have
# meant silent, permanent under-collection past the batch limit, not a retry). MAX_INVOCATIONS
# caps the drain well under the endpoint's own 10/hour rate limit (server/routes/cron.ts
# checkRateLimit) even with this loop. Capacity note: AUTOPAY_BATCH_LIMIT (8) x MAX_INVOCATIONS
# (8) = 64 leases debited per run, maximum. At the current ~140-tenant portfolio, roughly 50%+
# autopay enrollment exceeds that in one run — the leftover `remaining` count then waits for the
# NEXT scheduled fire (a full month, for this endpoint), not a same-day retry. Revisit both
# constants once OI-068 (autopay enrollment) ships and real enrollment numbers exist.
#
# Also reads the response BODY on a non-2xx status instead of losing it — PowerShell 5.1's
# Invoke-RestMethod catch block does not reliably populate $_.ErrorDetails.Message, so without
# explicitly reading the response stream, the endpoint's own errorMessages (why zero charges
# posted, or why the autopay pre-check failed) were unrecoverable exactly when they mattered most
# (round-2 review finding: the HTTP-500-on-failure change was a diagnostic dead end on this shell).
# round 4: the body-read fix alone wasn't enough — 401/429/400 responses (and the leases-select
# failure) carry `{ error: "..." }`, not `{ errorMessages: [...] }`, so the message extraction
# below falls through errorMessages -> error -> the raw $_ instead of assuming one shape.
#
# round 5 (review finding #1): a lease whose Stripe call deterministically fails every time (a
# closed bank account, a revoked mandate, or a bad STRIPE_SECRET_KEY failing ALL of them) never
# gets a payments row, so it re-occupies the same front-of-batch slot on every retry — `remaining`
# can get stuck at a fixed nonzero value while burning the whole MAX_INVOCATIONS budget on the
# same doomed leases, previously exiting 0 and surfacing nothing. This script cannot fix that
# server-side ordering problem (see cron.ts's own note on it), but it can stop making it worse:
# the loop now breaks and exits 1 the moment `remaining` fails to decrease between two calls,
# instead of exhausting MAX_INVOCATIONS silently.
param(
  [string]$Secret  = $env:ORA_PM_CRON_SECRET,
  [string]$BaseUrl = "https://ora-pm.pages.dev"
)

$year  = (Get-Date).Year
$month = (Get-Date).Month
$MAX_INVOCATIONS = 8
$TIMEOUT_SEC = 60 # round 5: this endpoint's whole reason for existing is subrequest-budget
                  # exhaustion inside the Worker, which can mean the connection accepts and then
                  # stalls rather than failing fast — an unattended task must not hang forever.

function Get-ErrorResponseBody {
  param($ErrorRecord)
  if (-not $ErrorRecord.Exception.Response) { return $null }
  try {
    $stream = $ErrorRecord.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $raw = $reader.ReadToEnd()
    $reader.Close()
    return $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
}

$invocation = 0
$totalPosted = 0
$totalSkipped = 0
$totalErrors = 0
$remaining = 1        # forces at least one call
$previousRemaining = $null
$stalled = $false

while ($remaining -gt 0 -and $invocation -lt $MAX_INVOCATIONS) {
  $invocation++
  $url = "$BaseUrl/api/cron/monthly-billing?year=$year&month=$month"

  try {
    $response = Invoke-RestMethod -Method POST -Uri $url `
      -Headers @{ Authorization = "Bearer $Secret" } `
      -ContentType "application/json" `
      -TimeoutSec $TIMEOUT_SEC

    $totalPosted  += $response.posted
    $totalSkipped += $response.skipped
    $totalErrors  += $response.errors
    $remaining = if ($null -ne $response.remaining) { $response.remaining } else { 0 }

    Write-Host "Billing triggered (call $invocation): posted=$($response.posted) skipped=$($response.skipped) errors=$($response.errors) chargeErrors=$($response.chargeErrors) autopayErrors=$($response.autopayErrors) remaining=$remaining"
    # Print every message, not only when errors > 0: some (e.g. a balance-forward lookup warning)
    # are reported without counting as errors and were invisible here.
    if ($response.errorMessages -and $response.errorMessages.Count -gt 0) {
      Write-Warning "Messages: $($response.errorMessages -join ', ')"
    }
    # Lease-term exceptions (past end_date / invalid dates) are not errors - those leases were
    # deliberately NOT billed and need a human holdover/date decision - but they must be visible.
    if ($response.leaseExceptions -and $response.leaseExceptions.Count -gt 0 -and $invocation -eq 1) {
      $list = ($response.leaseExceptions | ForEach-Object { "$($_.lease_id) [$($_.reason), end $($_.end_date)]" }) -join '; '
      Write-Warning "Lease-term exceptions NOT billed this period ($($response.leaseExceptions.Count)): $list"
    }

    if ($null -ne $previousRemaining -and $remaining -gt 0 -and $remaining -ge $previousRemaining) {
      # No progress since the last call - draining further would just repeat the same doomed
      # batch (round-5 review finding: a persistently-failing lease re-occupies the same slot).
      $stalled = $true
      break
    }
    $previousRemaining = $remaining
  } catch {
    $body = Get-ErrorResponseBody $_
    $detail = if ($body -and $body.errorMessages) {
      $body.errorMessages -join '; '
    } elseif ($body -and $body.error) {
      $body.error
    } else {
      "$_"
    }
    Write-Error "Billing trigger failed (call $invocation): $detail"
    # A hard failure (whole-batch error, HTTP 500) means never debit blind - stop draining rather
    # than hammering a broken endpoint up to MAX_INVOCATIONS times.
    exit 1
  }
}

if ($stalled) {
  Write-Error "Stopped after $invocation call(s): remaining did not decrease ($previousRemaining -> $remaining) - the same lease(s) are likely failing every attempt (bad payment method, revoked mandate, or a bad Stripe key). Investigate before re-running; repeating will not help."
  exit 1
}

if ($remaining -gt 0) {
  Write-Warning "Stopped after $invocation call(s) with $remaining autopay-eligible lease(s) still unprocessed this period (MAX_INVOCATIONS reached) - re-run manually or wait for the next scheduled fire."
}

Write-Host "Totals across $invocation call(s): posted=$totalPosted skipped=$totalSkipped errors=$totalErrors"
