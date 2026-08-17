import { Hono } from 'hono'
import { getDb } from '../db/client'
import { getStripe } from '../lib/stripe'
import { buildMonthlyCharges } from '../lib/billing'
import { cronAuthMiddleware } from '../middleware/auth'
import { checkRateLimit } from '../lib/rate-limit'

// Runs `fetchChunk` once per chunkSize-sized slice of `ids`, concatenating results — used to keep
// every `.in('lease_id', ids)` bulk query under a proxy URL-length limit regardless of how many
// ids are involved, instead of either one unbounded query (risks the URL-length wall) or one
// query per id (the O(leases) subrequest bug this whole file exists to avoid). Stops and surfaces
// the error on the first failing chunk — never returns partial data silently, since a caller here
// must be able to tell "some ids' state is unknown" from "confirmed empty."
async function fetchChunked<T>(
  ids: string[],
  chunkSize: number,
  // PromiseLike, not Promise: Supabase's un-awaited query builder is thenable (awaitable at
  // runtime) but doesn't structurally satisfy the full Promise interface (catch/finally/
  // Symbol.toStringTag) that TS requires for a bare Promise<...> parameter type.
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await fetchChunk(ids.slice(i, i + chunkSize))
    if (error) return { data: all, error }
    all.push(...(data ?? []))
  }
  return { data: all, error: null }
}

type Env = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
  RATE_LIMIT_KV?: KVNamespace
}

export const cronRouter = new Hono<{ Bindings: Env }>()

cronRouter.use('/*', cronAuthMiddleware)

// OI-038 remainder: 10/hour per cron endpoint path (not per caller — the
// only expected callers are the standalone Windows Task Scheduler triggers
// (scripts/trigger-billing.ps1; C:\Users\Owner\ora-pm-cron\ping-crons.ps1 —
// neither is the Claude fleet's own create_scheduled_task registry),
// authenticated via CRON_SECRET; runs AFTER cronAuthMiddleware so an invalid-secret guess
// never consumes budget). Sized generous specifically to absorb a
// legitimate catch-up burst — if the scheduler misses a run (e.g. an
// outage) it re-triggers the missed cron(s) close together on recovery.
// This repo has no separate catch-up-burst doc to size precisely against
// (checked: no match for "catch-up"/"catchup" in any tracked file), so this
// errs generous per task-6-brief.md's explicit instruction rather than risk
// breaking legitimate ops; each endpoint's own documented cadence (monthly,
// or once daily) is nowhere near 10/hour in normal operation.
cronRouter.use('/*', async (c, next) => {
  const { allowed, retryAfterMs } = await checkRateLimit(c.env.RATE_LIMIT_KV, c.req.path, {
    scope: 'cron',
    maxCalls: 10,
    windowMs: 60 * 60 * 1000,
  })
  if (!allowed) {
    return c.json({ error: `Too many cron requests — retry in ${Math.ceil(retryAfterMs / 1000)}s` }, 429)
  }
  return next()
})

// POST /api/cron/monthly-billing?year=2026&month=6
//
// OI-162/#1 (2026-08-16): the original per-lease-insert, per-lease-query implementation hit
// Cloudflare Workers' per-invocation subrequest limit on its first production run (139 active
// leases) — 49 billed, 90 got nothing, and a re-run would hit the identical wall every time
// (fresh subrequest budget per invocation, same O(leases) shape). Full five-round incident/fix
// history (the early rounds moved the same underlying failure mode deeper into the autopay debit
// path before landing here — worth reading before "simplifying" this file back toward per-lease
// queries): ~/.claude/projects/.../memory/event_log.md, entry "OI-162 monthly-billing batching
// fix", 2026-08-16 (ORA's cross-repo history log — not a file in this repo).
//
// Design invariants this file depends on — do not violate silently:
//   - Charge posting and every "did we already collect autopay" check are BULK queries
//     (`.upsert`/`.in`, chunked via `fetchChunked` at BULK_QUERY_CHUNK_SIZE ids) so subrequest
//     count stays O(1) — or O(ids / 100) for the chunked ones — never O(leases).
//   - Debit-input lookups (open-charges, period-paid, ar_ledger balance) are fetched for the
//     FULL not-yet-collected set, not just the batch about to be processed — resolving every
//     lease's debit amount before applying AUTOPAY_BATCH_LIMIT is what lets zero-debit leases
//     (already paid manually) clear immediately instead of occupying a batch slot forever. Only
//     leases that need an actual Stripe call are subject to the batch limit.
//   - A failed charge upsert (`chargesBulkFailed`) defers the ENTIRE autopay phase — it does not
//     run debit logic against charges known not to have been posted (that used to compute every
//     lease as zero-debit and report `remaining: 0`, i.e. "nothing left to do," when the whole
//     portfolio was actually still outstanding).
//   - `remaining` must equal every eligible lease that did NOT get either resolved-as-zero-debit
//     or a debit attempt this invocation — a failed pre-check, a failed debit-input lookup, the
//     batch-limit slice, or a deferred-by-chargesBulkFailed run all count. `trigger-billing.ps1`
//     loops on this; an undercount there is silent, permanent revenue under-collection, not a retry.
//   - `chargesBulkFailed` / `priorAutopayCheckFailed` / `debitInputsBulkFailed` are whole-batch
//     failures ("never debit blind") and return HTTP 500 — never look like a normal 200.
//   - AUTOPAY_BATCH_LIMIT is MAX SAFE for this endpoint's subrequest budget, not "conservative."
//     Fixed cost per invocation is `2 + ceil(eligible/100) + 3×ceil(notYetCollected/100)`
//     (leases-select + charges-upsert + prior-check chunks + the three debit-input chunk sets),
//     plus 2 more if RATE_LIMIT_KV is ever provisioned (currently commented out in wrangler.toml,
//     costs 0 today). Each Stripe call is 1-2 subrequests (`maxNetworkRetries: 1` in
//     server/lib/stripe.ts) plus 1 for the payments insert. Raising the limit means recomputing
//     that formula against the actual Cloudflare plan's ceiling (Free=50, Paid=1000 —
//     UNVERIFIED from this repo, confirm in the dashboard), not eyeballing a smaller number.
//     AUTOPAY_BATCH_LIMIT × trigger-billing.ps1's MAX_INVOCATIONS is also a hard per-run debit
//     ceiling (64 today) — see that script for the capacity note.
//   - Every Stripe call carries a deterministic `idempotencyKey` (`autopay:<leaseId>:<period>`),
//     so a retry — from `maxNetworkRetries`, a re-run, or the drain loop — is never itself a
//     double-charge risk within Stripe's ~24h idempotency window.
//   - KNOWN RESIDUAL (not fixed): `leases`/`needsDebit` have no explicit ordering, so a lease
//     whose Stripe call fails DETERMINISTICALLY every attempt (bad payment method, revoked
//     mandate, a bad STRIPE_SECRET_KEY failing all of them) can re-occupy the same batch slot on
//     every drain-loop iteration, starving healthy leases behind it — the same failure shape the
//     zero-debit-lease fix above closed, triggered by a different condition. Mitigated
//     client-side (`trigger-billing.ps1` breaks the drain loop if `remaining` stops decreasing),
//     not fixed server-side. A real fix needs failure-aware lease ordering (e.g. a last-attempt
//     timestamp or failure count that rotates persistently-failing leases to the back) — deferred
//     given zero autopay-eligible leases exist in production today.
// Currently ZERO leases are autopay-eligible in production (autopay enrollment isn't reachable
// from the tenant portal yet, OI-068) — the entire debit-processing path, batch limit, and drain
// loop are unexercised at real scale. This is deliberately in place before that gap closes.
// `errors` mixes units (charges vs. leases) — `chargeErrors`/`autopayErrors` split it, but
// `trigger-billing.ps1` only checks the sum today; not fixed further, by design (event_log.md).
cronRouter.post('/monthly-billing', async (c) => {
  const db = getDb(c.env)
  const now = new Date()
  const year  = parseInt(c.req.query('year')  ?? String(now.getFullYear()))
  const month = parseInt(c.req.query('month') ?? String(now.getMonth() + 1))

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return c.json({ error: 'Invalid year or month' }, 400)
  }

  const AUTOPAY_BATCH_LIMIT = 8
  const BULK_QUERY_CHUNK_SIZE = 100

  const periodStartStr = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEndStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const { data: leases, error: leaseErr } = await db
    .from('leases')
    .select('id, tenant_id, base_rent_monthly, cam_estimate_monthly, start_date, autopay_enabled, autopay_payment_method_id, tenants(id, stripe_customer_id)')
    .eq('status', 'active')

  if (leaseErr) return c.json({ error: leaseErr.message }, 500)

  let posted = 0, skipped = 0
  let chargeErrors = 0, autopayErrors = 0
  const errorMessages: string[] = []
  let chargesBulkFailed = false

  // --- Step 1: charge posting — one bulk upsert for the whole portfolio, not one insert/charge. ---
  const allCharges = (leases ?? []).flatMap((lease) =>
    buildMonthlyCharges({
      leaseId: lease.id,
      baseRentMonthly: lease.base_rent_monthly,
      camEstimateMonthly: lease.cam_estimate_monthly,
      leaseStartDate: lease.start_date,
      periodYear: year,
      periodMonth: month,
    }).charges
  )

  if (allCharges.length > 0) {
    const { data: insertedCharges, error: chargesErr } = await db
      .from('charges')
      .upsert(allCharges, { onConflict: 'idempotency_key', ignoreDuplicates: true })
      .select('idempotency_key')

    if (chargesErr) {
      chargesBulkFailed = true
      chargeErrors += allCharges.length
      errorMessages.push(`bulk charge upsert failed (batch of ${allCharges.length}), ZERO charges posted this run: ${chargesErr.message}`)
    } else {
      posted += insertedCharges?.length ?? 0
      skipped += allCharges.length - (insertedCharges?.length ?? 0)
    }
  }

  // --- Step 2: autopay eligibility + prior-period pre-check (bulk, one query for all eligible). ---
  const eligibleLeases = (leases ?? []).filter((lease) => {
    const tenant = Array.isArray(lease.tenants) ? lease.tenants[0] : lease.tenants
    return Boolean(lease.autopay_enabled && lease.autopay_payment_method_id && tenant?.stripe_customer_id)
  })

  let alreadyCollected = new Set<string>()
  let priorAutopayCheckFailed = false

  // Round-5 review finding #2: a failed charge upsert must stop autopay here too, not just
  // return 500 at the end. Before this guard, a chargesBulkFailed run still ran the full autopay
  // phase against charges that are known NOT to have been posted — every lease then computed
  // periodChargeTotal=0 (nothing in the DB to find) and got silently counted `skipped` ("nothing
  // outstanding") instead of deferred, `remaining` read 0 ("nothing left to do"), and 4-6
  // subrequests were spent on input the code already knew was garbage. Skip straight to
  // "everything eligible is still outstanding" instead.
  if (eligibleLeases.length > 0 && !chargesBulkFailed) {
    // Idempotency guard: one autopay collection per lease per billing period. autopay_period is
    // stamped with the canonical period start (periodStartStr, always the first of the billing
    // month), so a catch-up-burst re-run or a manual re-trigger days later produces the same
    // value and is caught here — and, in a concurrent race, by the payments_autopay_period_uniq
    // index below. Chunked (via fetchChunked) at BULK_QUERY_CHUNK_SIZE ids per `.in()` call — an
    // unbounded single call risks a proxy URL-length limit once the eligible-lease count grows
    // past ~180-200.
    const eligibleIds = eligibleLeases.map((l) => l.id)
    const { data: priorAutopay, error: priorErr } = await fetchChunked(
      eligibleIds,
      BULK_QUERY_CHUNK_SIZE,
      (chunk) => db.from('payments').select('lease_id').in('lease_id', chunk).eq('autopay_period', periodStartStr)
    )

    if (priorErr) {
      // Unknown whether these leases were already collected — never debit blind. Skip the
      // whole autopay phase this run rather than guessing per lease; next run retries all of it.
      priorAutopayCheckFailed = true
      autopayErrors += eligibleLeases.length
      errorMessages.push(`autopay period pre-check failed (batch of ${eligibleLeases.length}), autopay skipped entirely this run: ${priorErr.message}`)
    } else {
      for (const p of priorAutopay as { lease_id: string }[]) alreadyCollected.add(p.lease_id)
    }
  }

  // --- Step 3: autopay debit processing. ---
  const autopayDeferred = priorAutopayCheckFailed || chargesBulkFailed
  const notYetCollected = autopayDeferred
    ? []
    : eligibleLeases.filter((l) => !alreadyCollected.has(l.id))
  if (!autopayDeferred) {
    skipped += eligibleLeases.length - notYetCollected.length // already collected this period
  }
  let remaining = autopayDeferred ? eligibleLeases.length : 0
  let debitInputsBulkFailed = false

  if (notYetCollected.length > 0) {
    const ids = notYetCollected.map((l) => l.id)

    // Debit inputs are fetched for the FULL not-yet-collected set (chunked at
    // BULK_QUERY_CHUNK_SIZE ids per query, same pattern as the prior-period pre-check above) —
    // NOT pre-limited to AUTOPAY_BATCH_LIMIT. Round-3 limited this fetch itself to a small batch,
    // which meant a run of already-fully-paid leases (debitAmount <= 0 — no Stripe call, cheap to
    // resolve) could occupy the whole batch and starve leases that genuinely needed collecting:
    // the drain loop would then report the same `remaining` count forever, never converging
    // (round-4 review, empirically reproduced: 8-of-10 zero-debit leases deadlocked at
    // remaining=2 for 8 straight invocations). Fetching inputs for everyone lets zero-debit
    // leases resolve immediately regardless of position, and AUTOPAY_BATCH_LIMIT is applied only
    // to the leases that actually need a Stripe call below.
    const [openChargesRes, periodPaymentsRes, arRes] = await Promise.all([
      fetchChunked(ids, BULK_QUERY_CHUNK_SIZE, (chunk) =>
        db.from('charges').select('lease_id, amount').in('lease_id', chunk).gte('due_date', periodStartStr).lte('due_date', periodEndStr)),
      // Period-paid: manual (check/wire/other) or succeeded ACH payments dated WITHIN this
      // period. Autopay is only authorized to collect THIS period's rent — it must never sweep
      // older, unrelated arrears via an automated ACH debit the tenant didn't specifically
      // authorize for that purpose.
      fetchChunked(ids, BULK_QUERY_CHUNK_SIZE, (chunk) =>
        db.from('payments').select('lease_id, amount, method, stripe_status').in('lease_id', chunk).gte('payment_date', periodStartStr).lte('payment_date', periodEndStr)),
      // Lifetime cap: never debit more than the lease's true outstanding AR balance — however
      // period-scoping above is what prevents re-debiting a tenant who already paid THIS period
      // and what prevents sweeping arrears from an earlier period into an unrelated autopay charge.
      fetchChunked(ids, BULK_QUERY_CHUNK_SIZE, (chunk) => db.from('ar_ledger').select('lease_id, balance').in('lease_id', chunk)),
    ])

    if (openChargesRes.error || periodPaymentsRes.error || arRes.error) {
      // Unknown open-charge/paid/balance state for this whole set — never debit blind. None of
      // notYetCollected got a debit attempt, so all of it is still outstanding.
      debitInputsBulkFailed = true
      autopayErrors += notYetCollected.length
      remaining += notYetCollected.length
      const which = [
        openChargesRes.error && 'open-charges',
        periodPaymentsRes.error && 'period-payments',
        arRes.error && 'ar_ledger',
      ].filter(Boolean).join(', ')
      errorMessages.push(`autopay input lookup failed (${which}) for a batch of ${notYetCollected.length} leases, skipped: ${(openChargesRes.error ?? periodPaymentsRes.error ?? arRes.error)?.message}`)
    } else {
      const chargesByLease = new Map<string, number>()
      for (const row of openChargesRes.data as { lease_id: string; amount: number }[]) {
        chargesByLease.set(row.lease_id, (chargesByLease.get(row.lease_id) ?? 0) + row.amount)
      }
      const paidByLease = new Map<string, number>()
      for (const p of periodPaymentsRes.data as { lease_id: string; amount: number; method: string; stripe_status?: string }[]) {
        const counts = (p.method === 'ach_stripe' && p.stripe_status === 'succeeded') || ['check', 'wire', 'other'].includes(p.method)
        if (counts) paidByLease.set(p.lease_id, (paidByLease.get(p.lease_id) ?? 0) + p.amount)
      }
      const balanceByLease = new Map<string, number>()
      for (const row of arRes.data as { lease_id: string; balance: number }[]) {
        balanceByLease.set(row.lease_id, row.balance)
      }

      // Resolve EVERY not-yet-collected lease's debit amount now (cheap, in-memory) so
      // zero-debit leases are settled this run regardless of batch position — only leases that
      // actually need a real Stripe call are subject to AUTOPAY_BATCH_LIMIT.
      const debitAmountByLease = new Map<string, number>()
      const needsDebit: typeof notYetCollected = []
      for (const lease of notYetCollected) {
        const periodChargeTotal = chargesByLease.get(lease.id) ?? 0
        const periodPaid = paidByLease.get(lease.id) ?? 0
        const periodOutstanding = Math.max(0, periodChargeTotal - periodPaid)
        const outstandingBalance = balanceByLease.get(lease.id) ?? 0
        const debitAmount = Math.min(periodOutstanding, outstandingBalance)
        debitAmountByLease.set(lease.id, debitAmount)
        if (debitAmount <= 0) {
          skipped++ // nothing outstanding to collect for this period — resolved now, not deferred
        } else {
          needsDebit.push(lease)
        }
      }

      const toProcess = needsDebit.slice(0, AUTOPAY_BATCH_LIMIT)
      remaining += needsDebit.length - toProcess.length

      const stripe = getStripe(c.env.STRIPE_SECRET_KEY)

      for (const lease of toProcess) {
        const tenant = Array.isArray(lease.tenants) ? lease.tenants[0] : lease.tenants
        const debitAmount = debitAmountByLease.get(lease.id) as number

        try {
          const pi = await stripe.paymentIntents.create({
            amount: Math.round(debitAmount * 100),
            currency: 'usd',
            customer: tenant.stripe_customer_id,
            payment_method: lease.autopay_payment_method_id,
            payment_method_types: ['us_bank_account'],
            confirm: true,
            off_session: true,
            description: `Autopay — ${periodStartStr}`,
            metadata: { lease_id: lease.id, tenant_id: tenant.id },
          }, {
            // Deterministic per lease+period: a re-run inside Stripe's idempotency window (~24h)
            // returns the original PaymentIntent instead of debiting again. Beyond that window,
            // alreadyCollected (this run's or a future run's) is the only guard — which is why
            // this phase is intentionally batch-limited: a wide-open, unbounded loop risks the
            // subrequest budget running out AFTER this call but BEFORE the payments insert below
            // records it, leaving no alreadyCollected row once the Stripe key also expires.
            idempotencyKey: `autopay:${lease.id}:${periodStartStr}`,
          })
          const { error: payErr } = await db.from('payments').insert({
            lease_id: lease.id,
            payment_date: new Date().toISOString().slice(0, 10),
            amount: debitAmount,
            method: 'ach_stripe',
            stripe_payment_intent_id: pi.id,
            stripe_status: pi.status,
            notes: `Autopay — ${periodStartStr}`,
            autopay_period: periodStartStr,
          })
          if (payErr) {
            if (payErr.code === '23505') {
              skipped++ // concurrent run recorded this period first (idempotent)
            } else {
              // Real insert failure — the debit happened but wasn't recorded; surface loudly.
              autopayErrors++
              errorMessages.push(`autopay lease ${lease.id}: payment ${pi.id} created but not recorded: ${payErr.message}`)
            }
          }
        } catch (err) {
          autopayErrors++
          errorMessages.push(`autopay lease ${lease.id}: ${(err as Error).message}`)
        }
      }
    }
  }

  const errors = chargeErrors + autopayErrors
  // Any of these three means a whole batch failed as a unit, not a per-lease shortfall — that
  // must not look like a normal 200 (OI-162/#1 review round 2 finding #2, round 3 finding #7):
  // the charge-bulk-upsert failing means the ENTIRE portfolio got zero charges this run; a failed
  // autopay pre-check or debit-input lookup means that whole batch got zero debit attempts.
  const status = (chargesBulkFailed || priorAutopayCheckFailed || debitInputsBulkFailed) ? 500 : 200
  return c.json({ posted, skipped, errors, chargeErrors, autopayErrors, errorMessages, remaining, year, month }, status)
})

cronRouter.post('/critical-dates-alerts', async (c) => {
  const db = getDb(c.env)
  // OI-047: RECIPIENTS only scopes the sent_notifications dedup-key set
  // (`${reference_id}:${recipient}`) now — it no longer controls who
  // actually receives mail. The actual send recipient is $script:EmailTo in
  // C:\Users\Owner\ora-pm-cron\ping-crons-lib.ps1 (separately maintained).
  // Changing one without the other either has no effect on delivery, or
  // writes dedup rows for an address that never gets mail.
  const RECIPIENTS = ['ggoldberg@oxfordra.net']
  const HORIZON_DAYS = 90

  // Query critical dates within horizon
  const horizonDate = new Date()
  horizonDate.setDate(horizonDate.getDate() + HORIZON_DAYS)
  const horizonStr = horizonDate.toISOString().slice(0, 10)

  const { data: criticalDates, error: cdErr } = await db
    .from('critical_dates')
    .select('*')
    .lte('critical_date', horizonStr)

  if (cdErr) return c.json({ error: cdErr.message }, 500)
  if (!criticalDates || criticalDates.length === 0) {
    return c.json({ new_alerts: 0, skipped: 0, email: null })
  }

  // Dedup: check which reference_ids already notified this recipient
  const refIds = criticalDates.map((r: { reference_id: string }) => r.reference_id)
  const { data: alreadySent } = await db
    .from('sent_notifications')
    .select('reference_id, recipient')
    .in('reference_id', refIds)

  const sentSet = new Set((alreadySent ?? []).map((s: { reference_id: string; recipient: string }) => `${s.reference_id}:${s.recipient}`))

  // Determine new alerts (items not yet sent to at least one recipient)
  type CritRow = { date_type: string; reference_id: string; tenant_name: string; property_name: string | null; suite: string | null; critical_date: string; days_until: number; urgency: string }
  const newAlerts: CritRow[] = (criticalDates as CritRow[]).filter(r =>
    RECIPIENTS.some(rec => !sentSet.has(`${r.reference_id}:${rec}`))
  )

  if (newAlerts.length === 0) {
    return c.json({ new_alerts: 0, skipped: criticalDates.length, email: null })
  }

  // Record in sent_notifications (upsert / ignore duplicates)
  const notifications = newAlerts.flatMap(r =>
    RECIPIENTS.map(rec => ({
      notification_type: 'critical_date_alert',
      reference_id: r.reference_id,
      recipient: rec,
    }))
  )

  // Record dedup rows BEFORE building the email digest — if this fails, return
  // without one so the next run retries cleanly rather than re-reporting
  // alerts the principal already received (OI-047: dedup-before-send is
  // preserved unchanged; only the actual send moved out of this Worker).
  const { error: insErr } = await db.from('sent_notifications').insert(notifications)
  if (insErr) return c.json({ error: `Failed to record notifications: ${insErr.message}` }, 500)

  // Build email digest
  const urgencyOrder: Record<string, number> = { overdue: 0, urgent: 1, warning: 2, notice: 3 }
  const sorted = [...newAlerts].sort((a, b) => (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9))

  const urgencyLabel: Record<string, string> = { overdue: '🔴 OVERDUE', urgent: '🟠 URGENT (≤30d)', warning: '🟡 WARNING (≤60d)', notice: '⚪ NOTICE (≤90d)' }

  const lines = sorted.map(r => {
    const location = [r.property_name, r.suite].filter(Boolean).join(' · ')
    return `${urgencyLabel[r.urgency] ?? r.urgency} | ${r.date_type.replace(/_/g,' ')} | ${r.tenant_name} | ${location} | ${r.critical_date} (${r.days_until}d)`
  })

  const bodyText = `ORA PM — Critical Dates Alert\n${new Date().toISOString().slice(0,10)}\n\n${lines.join('\n')}\n\nTotal: ${newAlerts.length} item(s)\nhttps://ora-pm.pages.dev/critical-dates`

  // OI-047 (2026-08-04): this Worker no longer emails anyone directly (that
  // was a second, independently-credentialed egress path outside the ORA
  // send-path canon). It hands the digest back in the response; the ORA
  // scheduler (ping-crons.ps1) sends it via Outlook COM.
  const subject = `[ORA PM] ${newAlerts.length} Critical Date${newAlerts.length > 1 ? 's' : ''} — ${new Date().toISOString().slice(0,10)}`

  return c.json({
    new_alerts: newAlerts.length,
    skipped: criticalDates.length - newAlerts.length,
    email: { subject, body: bodyText },
  })
})

cronRouter.post('/delinquency-check', async (c) => {
  const db = getDb(c.env)
  const today = new Date().toISOString().slice(0, 10)
  const [year, month] = today.split('-')
  const periodStart = `${year}-${month}-01`
  const GRACE_DAYS = 30
  const LATE_FEE_AMOUNT = 50 // $50 flat late fee — adjust as needed
  const BULK_QUERY_CHUNK_SIZE = 100

  // Fetch AR ledger rows with a positive balance
  const { data: arRows, error: arErr } = await db
    .from('ar_ledger')
    .select('*')
    .gt('balance', 0)

  if (arErr) return c.json({ error: arErr.message }, 500)
  if (!arRows || arRows.length === 0) return c.json({ late_fees_posted: 0, delinquent_count: 0, email: null })

  type ARRow = { lease_id: string; tenant_id: string; tenant_name: string; property_name: string | null; suite: string | null; balance: number }

  // GRACE_DAYS cutoff is the same for every row — compute once.
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - GRACE_DAYS)
  const cutoffStr = cutoffDate.toISOString().slice(0, 10)

  // Bulk existence checks (2026-08-17 fix, OI-pending): the prior version ran these two lookups
  // per lease inside the loop below — up to 2 sequential Supabase round-trips per AR row, which
  // reliably exceeded ping-crons.ps1's 240s client timeout once the AR set grew past ~30-40 rows
  // (live-confirmed 2026-08-17 at 68 rows: Cloudflare logged the invocation itself as `Canceled`,
  // still running, no error). Chunked via fetchChunked at BULK_QUERY_CHUNK_SIZE ids per `.in()`
  // call, same pattern as monthly-billing above — 2 bulk queries total instead of up to 2*N.
  // Selecting `lease_id` only and testing set membership is behaviorally identical to the old
  // per-row `.limit(1)` existence check: both only ever tested "does at least one matching charge
  // exist for this lease," never used the row's own field values.
  const leaseIds = (arRows as ARRow[]).map((ar) => ar.lease_id)
  const [overdueRes, existingFeeRes] = await Promise.all([
    fetchChunked(leaseIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
      db.from('charges').select('lease_id').in('lease_id', chunk).lte('due_date', cutoffStr)),
    fetchChunked(leaseIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
      db.from('charges').select('lease_id').in('lease_id', chunk).eq('type', 'late_fee').gte('charge_date', periodStart)),
  ])

  // Intentional behavior change from the pre-fix code, not just a mechanical batching swap: the
  // old per-row queries never checked their own error at all (`const { data } = await db...`), so
  // a query failure silently fell through the `!data || data.length === 0` guard and just skipped
  // that one lease — under-reporting delinquency without surfacing it. These bulk checks fail the
  // whole request closed instead, matching this function's own top-level `arErr` convention above
  // (never report a delinquency digest built from partially-unknown data).
  if (overdueRes.error) return c.json({ error: overdueRes.error.message }, 500)
  if (existingFeeRes.error) return c.json({ error: existingFeeRes.error.message }, 500)

  const overdueLeaseIds = new Set((overdueRes.data as { lease_id: string }[]).map((r) => r.lease_id))
  const existingFeeLeaseIds = new Set((existingFeeRes.data as { lease_id: string }[]).map((r) => r.lease_id))

  let lateFeesPosted = 0
  const delinquentLeases: { tenant_name: string; property: string; balance: number }[] = []

  for (const ar of arRows as ARRow[]) {
    if (!overdueLeaseIds.has(ar.lease_id)) continue

    if (existingFeeLeaseIds.has(ar.lease_id)) {
      delinquentLeases.push({ tenant_name: ar.tenant_name, property: [ar.property_name, ar.suite].filter(Boolean).join(' '), balance: ar.balance })
      continue
    }

    // Post late fee charge — still one insert per newly-delinquent lease (a small subset of the
    // AR set, not the full N), left un-batched because the 23505 idempotency-collision branch
    // below needs a per-row result.
    const { error: feeErr } = await db.from('charges').insert({
      lease_id: ar.lease_id,
      charge_date: today,
      due_date: today,
      period_start: periodStart,
      period_end: today,
      type: 'late_fee',
      amount: LATE_FEE_AMOUNT,
      description: `Late fee — balance outstanding as of ${today}`,
      source: 'auto',
      idempotency_key: `late_fee_${ar.lease_id}_${year}_${month}`,
    })

    const property = [ar.property_name, ar.suite].filter(Boolean).join(' ')
    if (!feeErr) {
      lateFeesPosted++
      delinquentLeases.push({ tenant_name: ar.tenant_name, property, balance: ar.balance + LATE_FEE_AMOUNT })
    } else if (feeErr.code === '23505') {
      // Unique idempotency_key collision — a concurrent/prior run already posted this
      // month's fee (the existingFee guard missed it by a hair). Still a delinquent tenant.
      delinquentLeases.push({ tenant_name: ar.tenant_name, property, balance: ar.balance })
    } else {
      // Real insert failure — surface it so a delinquent tenant isn't silently dropped.
      console.error(`late_fee insert failed for lease ${ar.lease_id}: ${feeErr.message}`)
      delinquentLeases.push({ tenant_name: ar.tenant_name, property, balance: ar.balance })
    }
  }

  // Build the delinquency digest — OI-047 (2026-08-04): return it instead of
  // emailing via Resend; ping-crons.ps1 sends it via Outlook COM. Late fees
  // above are already posted (or not) by this point regardless of what
  // happens to the digest — unchanged from today's behavior.
  let email: { subject: string; body: string } | null = null
  if (delinquentLeases.length > 0) {
    const lines = delinquentLeases.map(d => `  • ${d.tenant_name} | ${d.property} | Balance: $${d.balance.toFixed(2)}`)
    const bodyText = `ORA PM — Delinquency Report\n${today}\n\n${lines.join('\n')}\n\nLate fees posted: ${lateFeesPosted}\nhttps://ora-pm.pages.dev/ar`
    const subject = `[ORA PM] ${delinquentLeases.length} Delinquent Tenant${delinquentLeases.length > 1 ? 's' : ''} — ${today}`
    email = { subject, body: bodyText }
  }

  return c.json({ late_fees_posted: lateFeesPosted, delinquent_count: delinquentLeases.length, email })
})
