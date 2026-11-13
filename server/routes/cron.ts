import { Hono } from 'hono'
import Stripe from 'stripe'
import { getDb } from '../db/client'
import { getStripe } from '../lib/stripe'
import { buildMonthlyCharges, leaseTermStatusForPeriod } from '../lib/billing'
import { cronAuthMiddleware } from '../middleware/auth'
import { checkRateLimit } from '../lib/rate-limit'
import { fetchChunked, fetchAllPages, POSTGREST_MAX_ROWS } from '../lib/postgrest-paging'


type Env = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
  CRIT_ALERT_RECIPIENTS?: string
  LATE_FEES_ENABLED?: string
  RATE_LIMIT_KV?: KVNamespace
}

export const cronRouter = new Hono<{ Bindings: Env }>()

cronRouter.use('/*', cronAuthMiddleware)

// OI-038 remainder: 10/hour per cron endpoint path (not per caller),
// authenticated via CRON_SECRET; runs AFTER cronAuthMiddleware so an
// invalid-secret guess never consumes budget. Expected callers (the live ORA
// CC/MCP scheduled-task registry is the authority; see wrangler.toml and the
// README "Cron jobs" paragraph):
//   - ora-pm-monthly-billing (cron 10 11 1-3 * *) -> scripts/trigger-billing.ps1,
//     which re-invokes monthly-billing until `remaining` is 0 (cap 8 calls);
//   - ora-pm-daily-crons (cron 40 9 * * 1, WEEKLY despite the id) ->
//     ping-crons.ps1 on the ORA laptop (critical-dates-alerts,
//     delinquency-check);
//   - GitHub Actions backups monthly-billing-backup.yml (40 17 1 * * UTC) and
//     delinquency-backup.yml (10 16 * * * UTC), scheduled in a later hour
//     bucket than the laptop runs.
// The fleet tasks fire only while the Claude Desktop app is open, and missed
// runs fire together as a catch-up burst at the next open, so the limit is
// sized generously to absorb that burst; normal cadence (monthly, weekly, or
// once daily for the delinquency backup) is far below 10/hour.
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
//     or a debit attempt this invocation — a failed pre-check, a failed debit-input lookup, a
//     failed reserve_autopay_payment call (0031), the batch-limit slice, or a
//     deferred-by-chargesBulkFailed run all count. `trigger-billing.ps1`
//     loops on this; an undercount there is silent, permanent revenue under-collection, not a retry.
//   - `chargesBulkFailed` / `voidRecheckFailed` / `priorAutopayCheckFailed` / `debitInputsBulkFailed`
//     are whole-batch failures ("never debit blind") and return HTTP 500 — never look like a normal 200.
//     `reservationFailed` (a per-lease reservation RPC failure: unknown state) returns 500 too.
//   - Audit 2026-11-12 #1 / migration 0031: the debit amount is decided and the payments row is
//     written BEFORE the Stripe call, by reserve_autopay_payment() under the same per-lease lock
//     as the portal's reserve_payment_intent() (0014), netting in-flight ACH. The Stripe
//     idempotency key is per reservation; the reservation row is the per-period guard.
//   - `voidedSkipped` (PR #42 review follow-up): a charge-upsert skip can mean "already posted and
//     fine" OR "the existing row was voided" (migration 0016 never clears idempotency_key on void).
//     Every skipped key is re-checked and a voided match is flagged, NOT auto-reposted — this
//     endpoint has no way to tell "void = mistake, needs a correction" from "void = legitimate
//     write-off, stays gone" (voiding has no ruling here the way the late-fee guard below has one),
//     so an automatic repost was rejected on review as a silent way to reverse a real void.
//   - AUTOPAY_BATCH_LIMIT is MAX SAFE for this endpoint's subrequest budget, not "conservative."
//     Fixed cost per invocation is
//     `(floor(activeLeases/1000) + 1) + 1 + ceil(skipped/50) + ceil(eligible/100) + 3×ceil(notYetCollected/100)`
//     (keyset-paged leases select + charges-upsert + the voided-charge re-check chunks (PR #42
//     review follow-up, IDEMPOTENCY_KEY_CHUNK_SIZE=50 — usually 0 when nothing was skipped) +
//     prior-check chunks + the three debit-input chunk sets — the same `2 + …` as before until the
//     portfolio reaches 1000 active leases and a real skip batch appears), plus 2 more if
//     RATE_LIMIT_KV is ever provisioned (currently commented out in wrangler.toml, costs 0 today).
//     Each debited lease costs 1 for the reserve_autopay_payment RPC (migration 0031), 1-2 for
//     the Stripe call (`maxNetworkRetries: 1` in server/lib/stripe.ts) and 1 for the write-back
//     (or release). Raising the limit means recomputing
//     that formula against the actual Cloudflare plan's ceiling (Free=50, Paid=1000 —
//     UNVERIFIED from this repo, confirm in the dashboard), not eyeballing a smaller number.
//     AUTOPAY_BATCH_LIMIT × trigger-billing.ps1's MAX_INVOCATIONS is also a hard per-run debit
//     ceiling (64 today) — see that script for the capacity note.
//   - Every Stripe call carries a deterministic `idempotencyKey` (`autopay:<leaseId>:<period>`),
//     so a retry — from `maxNetworkRetries`, a re-run, or the drain loop — is never itself a
//     double-charge risk within Stripe's ~24h idempotency window.
//   - Row cap: every read here is either keyset-paged (leases) or a `fetchChunked` call with
//     `maxRows` — a response at PostgREST's silent `max_rows` cut is a whole-batch failure, never
//     data (see fetchChunked/fetchAllPages at the top of this file for what each would break).
//   - KNOWN RESIDUAL (not fixed): `leases`/`needsDebit` are ordered by lease id only (the keyset
//     paging order — deterministic, not failure-aware), so a lease
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
  // Half of BULK_QUERY_CHUNK_SIZE, specifically for the voided-charge re-check below: an
  // idempotency_key string (~40-60 chars, e.g. `auto:<uuid>:2026-06-01:cam_estimate`) is far
  // longer than the lease_id UUIDs every other chunked query here filters on, so the same chunk
  // size risks the request-URL length wall well before POSTGREST_MAX_ROWS (adversarial review,
  // this session — measured ~7.5KB at 100 keys against this endpoint's own documented ~7.2-8KB wall).
  const IDEMPOTENCY_KEY_CHUNK_SIZE = 50

  const periodStartStr = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEndStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  // Keyset-paged (fetchAllPages): a single select is cut at POSTGREST_MAX_ROWS with no error, and
  // every active lease past the cap would silently get no rent charge and no autopay attempt.
  const { data: leases, error: leaseErr } = await fetchAllPages((after) => {
    let q = db
      .from('leases')
      .select('id, tenant_id, base_rent_monthly, cam_estimate_monthly, start_date, end_date, autopay_enabled, autopay_payment_method_id, tenants(id, stripe_customer_id)')
      .eq('status', 'active')
    if (after !== null) q = q.gt('id', after)
    return q.order('id').limit(POSTGREST_MAX_ROWS)
  }, (lease) => lease.id)

  if (leaseErr) return c.json({ error: leaseErr.message }, 500)

  let posted = 0, skipped = 0
  let chargeErrors = 0, autopayErrors = 0
  const errorMessages: string[] = []

  // --- Step 0: lease-term gate (audit finding billing-ignores-lease-term). ---
  // status='active' alone used to decide billing, so a lease was charged, late-fee'd and
  // ACH-debited for months before its start_date and after its end_date (nothing transitions a lease
  // to 'expired'). Now, per lease, against THIS billing month:
  //   - not_started (start_date after month end): skipped quietly — a signed future lease is normal.
  //   - ended (end_date before month start): EXCLUDED from charges and autopay and surfaced in
  //     `leaseExceptions` + errorMessages for a human. Deliberately NOT billed at the old rent:
  //     whether a holdover tenant owes base rent, a holdover premium, or nothing (renewal pending,
  //     surrendered) is a business decision this endpoint cannot make — no holdover rate is invented.
  //   - invalid (missing/malformed dates): excluded and surfaced the same way (fail closed).
  //   - in_term: billed; buildMonthlyCharges prorates a mid-month start AND a mid-month end.
  // This is not an error (HTTP stays 200, `errors` unchanged): the run did what it should, and
  // trigger-billing.ps1 must not treat a lease awaiting a holdover decision as a failed run.
  type LeaseException = { lease_id: string; reason: 'past_end_date' | 'invalid_term_dates'; start_date: string | null; end_date: string | null }
  const leaseExceptions: LeaseException[] = []
  let notStarted = 0
  const inTermLeases = (leases ?? []).filter((lease) => {
    const term = leaseTermStatusForPeriod(lease.start_date, lease.end_date, year, month)
    if (term === 'in_term') return true
    if (term === 'not_started') { notStarted++; return false }
    leaseExceptions.push({
      lease_id: lease.id,
      reason: term === 'ended' ? 'past_end_date' : 'invalid_term_dates',
      start_date: lease.start_date ?? null,
      end_date: lease.end_date ?? null,
    })
    return false
  })
  const expiredUnbilled = leaseExceptions.filter((e) => e.reason === 'past_end_date').length
  if (expiredUnbilled > 0) {
    errorMessages.push(
      `${expiredUnbilled} lease(s) still status='active' but past its end_date were NOT billed and NOT `
      + 'autopay-debited for this period (see leaseExceptions) — decide holdover terms or mark the '
      + 'lease expired/renewed, then post any holdover charge manually.'
    )
  }
  const invalidTerm = leaseExceptions.length - expiredUnbilled
  if (invalidTerm > 0) {
    errorMessages.push(`${invalidTerm} lease(s) with missing/invalid start_date/end_date were NOT billed (see leaseExceptions) — fix the lease dates.`)
  }
  let chargesBulkFailed = false
  let voidRecheckFailed = false

  // --- Step 1: charge posting — one bulk upsert for the whole portfolio, not one insert/charge. ---
  const builtCharges = inTermLeases.flatMap((lease) =>
    buildMonthlyCharges({
      leaseId: lease.id,
      baseRentMonthly: lease.base_rent_monthly,
      camEstimateMonthly: lease.cam_estimate_monthly,
      leaseStartDate: lease.start_date,
      leaseEndDate: lease.end_date,
      periodYear: year,
      periodMonth: month,
    }).charges
  )

  let voidedSkipped = 0

  // --- Step 1a: balance forwards from QuickBooks (migration 0030). A lease's charges dated on or
  // before its live balance forward's as_of are frozen in the database (that history is inside the
  // QuickBooks figure), and the bulk upsert is ONE statement: a single refused row would fail it
  // for the whole portfolio. So such charges never enter the batch. Ones already posted are the
  // normal re-run case (counted as skipped); a genuinely new one (its idempotency key not found) is
  // never posted and counts as a chargeErrors entry, so trigger-billing.ps1 prints it. If the
  // balance-forward read fails, the batch goes out unfiltered (the database guard still refuses any
  // frozen row, so the worst case is the old whole-batch failure, never a wrong charge) and autopay
  // is deferred this run. A voided frozen charge is no longer re-checked (voidedSkipped): that
  // period is QuickBooks' figure.
  let frozenByBalanceForward = 0
  let allCharges = builtCharges
  let bfLookupFailed = false
  const bfCutoff = new Map<string, string>()
  const bfRes = inTermLeases.length === 0 ? { data: [], error: null }
    : await fetchChunked<{ lease_id: string; as_of: string }>(inTermLeases.map((l) => l.id), BULK_QUERY_CHUNK_SIZE, (chunk) =>
      db.from('balance_forwards').select('lease_id, as_of').in('lease_id', chunk).is('voided_at', null),
      { maxRows: POSTGREST_MAX_ROWS })
  if (bfRes.error) {
    bfLookupFailed = true
    chargeErrors += 1
    errorMessages.push(`balance-forward lookup failed; charges sent unfiltered (the database still refuses any dated on or before a QuickBooks cut-off) and autopay deferred: ${bfRes.error.message}`)
  } else if (bfRes.data.length > 0) {
    for (const b of bfRes.data) bfCutoff.set(b.lease_id, b.as_of)
    const frozen = builtCharges.filter((ch) => { const cut = bfCutoff.get(ch.lease_id); return cut !== undefined && ch.charge_date <= cut })
    if (frozen.length > 0) {
      allCharges = builtCharges.filter((ch) => !frozen.includes(ch))
      frozenByBalanceForward = frozen.length
      const existing = await fetchChunked<{ idempotency_key: string }>(frozen.map((ch) => ch.idempotency_key), IDEMPOTENCY_KEY_CHUNK_SIZE, (chunk) =>
        db.from('charges').select('idempotency_key').in('idempotency_key', chunk), { maxRows: POSTGREST_MAX_ROWS })
      if (existing.error) {
        chargeErrors += frozen.length
        errorMessages.push(`${frozen.length} charge(s) dated on or before a lease's QuickBooks cut-off were not posted; could not check whether they already exist: ${existing.error.message}`)
      } else {
        const have = new Set(existing.data.map((r) => r.idempotency_key))
        const missing = frozen.filter((ch) => !have.has(ch.idempotency_key))
        skipped += frozen.length - missing.length
        chargeErrors += missing.length
        if (missing.length > 0) {
          errorMessages.push(`${missing.length} new charge(s) dated on or before a lease's balance forward from QuickBooks were NOT posted (leases: ${[...new Set(missing.map((ch) => ch.lease_id))].join(', ')}) — that period is QuickBooks' figure; void the balance forward and re-import if it should change.`)
        }
      }
    }
  }

  if (allCharges.length > 0) {
    const { data: insertedCharges, error: chargesErr } = await db
      .from('charges')
      // 0032 REFUTE-11 D1: rows in lease-id order, so each charge's balance-forward guard takes its
      // lease lock in the same global order apply_balance_forwards uses (no deadlock).
      .upsert([...allCharges].sort((a, b) => (a.lease_id < b.lease_id ? -1 : a.lease_id > b.lease_id ? 1 : 0)), { onConflict: 'idempotency_key', ignoreDuplicates: true })
      .select('idempotency_key')

    if (chargesErr) {
      chargesBulkFailed = true
      chargeErrors += allCharges.length
      errorMessages.push(`bulk charge upsert failed (batch of ${allCharges.length}), ZERO charges posted this run: ${chargesErr.message}`)
    } else {
      const insertedKeys = new Set((insertedCharges ?? []).map((r) => r.idempotency_key as string))
      posted += insertedKeys.size
      const skippedCharges = allCharges.filter((ch) => !insertedKeys.has(ch.idempotency_key))
      skipped += skippedCharges.length

      // PR #42 review finding (idempotency_key survives voiding — migration 0016 only ever sets
      // voided_at/void_reason): the ignoreDuplicates skip above cannot tell "already posted and
      // fine" from "the existing row was voided" — a voided charge silently and permanently
      // occupies its key, indistinguishable from a routine already-posted skip in every count and
      // log line. late_fee accepts a version of this tradeoff on purpose (existing-fee guard
      // below, "never re-fee a voided month"); rent/cam_estimate never made that call.
      //
      // Auto-reposting under a corrected key was the first approach here and was REJECTED on
      // adversarial review (Fable pass, this session): voiding has no recorded reason this
      // endpoint can read (void_reason exists but is never checked) — it can mean "this was
      // wrong, replace it" OR "this tenant terminated / was abated, it's gone for good." Silently
      // re-billing every voided rent/cam_estimate charge on the next run would just as silently
      // REVERSE a legitimate void the moment anyone ever voids one of these charge types. Flag it
      // instead: surfaced via `voidedSkipped` and an errorMessages line so a human decides whether
      // a manual correction charge (source: 'manual', through the normal charges route) is
      // warranted — never automatic.
      if (skippedCharges.length > 0) {
        const skippedKeys = skippedCharges.map((ch) => ch.idempotency_key)
        const { data: existingRows, error: recheckErr } = await fetchChunked(
          skippedKeys,
          IDEMPOTENCY_KEY_CHUNK_SIZE,
          (chunk) => db.from('charges').select('idempotency_key, voided_at').in('idempotency_key', chunk),
          { maxRows: POSTGREST_MAX_ROWS }
        )

        if (recheckErr) {
          // Unknown which skipped keys are voided vs. genuinely already posted — leave them all
          // as ordinary skips (today's behavior) rather than guessing, and surface it as a real
          // failure (500, not a silent 200) so it isn't mistaken for "nothing to flag."
          voidRecheckFailed = true
          chargeErrors += skippedCharges.length
          errorMessages.push(`voided-charge re-check failed for a batch of ${skippedCharges.length} skipped charges, left as skipped this run: ${recheckErr.message}`)
        } else {
          voidedSkipped = (existingRows as { idempotency_key: string; voided_at: string | null }[])
            .filter((r) => r.voided_at !== null).length
          if (voidedSkipped > 0) {
            errorMessages.push(
              `${voidedSkipped} skipped charge(s) correspond to a VOIDED existing row for that `
              + 'lease-period, not re-posted automatically (voiding may be intentional) — review '
              + 'and post a manual correction charge if one is actually owed.'
            )
          }
        }
      }
    }
  }

  // --- Step 2: autopay eligibility + prior-period pre-check (bulk, one query for all eligible). ---
  // In-term leases only: an excluded lease (past end / not started / invalid dates) has no charge
  // this period and must never reach a Stripe debit, even via arrears headroom.
  // 0030: a lease whose balance forward from QuickBooks covers this billing month (as_of on or after
  // its first day) is not autopay-debited for it: the app cannot see what was paid for that month in
  // QuickBooks, so the debit would really sweep older arrears.
  const eligibleLeases = inTermLeases.filter((lease) => {
    const tenant = Array.isArray(lease.tenants) ? lease.tenants[0] : lease.tenants
    const cut = bfCutoff.get(lease.id)
    if (cut !== undefined && cut >= periodStartStr) return false
    return Boolean(lease.autopay_enabled && lease.autopay_payment_method_id && tenant?.stripe_customer_id)
  })

  const alreadyCollected = new Set<string>()
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
    //
    // Row cap: payments_autopay_period_uniq bounds this at one row per lease, so a 100-id chunk
    // can't legitimately reach it — but a dropped row here is the most dangerous truncation in the
    // file: that lease reads as uncollected and is debited AGAIN (its autopay row is `processing`,
    // so neither period-paid nor the ar_ledger balance below reflects it). Guarded regardless.
    const eligibleIds = eligibleLeases.map((l) => l.id)
    const { data: priorAutopay, error: priorErr } = await fetchChunked(
      eligibleIds,
      BULK_QUERY_CHUNK_SIZE,
      (chunk) => db.from('payments').select('lease_id').in('lease_id', chunk).eq('autopay_period', periodStartStr),
      { maxRows: POSTGREST_MAX_ROWS }
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
  const autopayDeferred = priorAutopayCheckFailed || chargesBulkFailed || bfLookupFailed
  const notYetCollected = autopayDeferred
    ? []
    : eligibleLeases.filter((l) => !alreadyCollected.has(l.id))
  if (!autopayDeferred) {
    skipped += eligibleLeases.length - notYetCollected.length // already collected this period
  }
  let remaining = autopayDeferred ? eligibleLeases.length : 0
  let debitInputsBulkFailed = false
  let reservationFailed = false

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
    //
    // Row cap — what a truncated chunk would do to the debit amount, min(period charges − period
    // paid, ar balance), if it weren't failed closed into debitInputsBulkFailed:
    //   - open-charges dropped  -> period total understated -> under-debit / resolved as zero (missed collection)
    //   - period-paid dropped   -> a manual payment vanishes -> OVER-DEBIT up to the AR balance (wrong charge)
    //   - ar_ledger row dropped -> balance reads 0 -> resolved as zero (missed collection)
    //
    // OI-278 / migration 0016: `.is('voided_at', null)` — a voided charge is an audit row, not
    // money owed. ar_ledger.balance already excludes it, but the lifetime cap is loose whenever
    // prior arrears exist, so an un-filtered period sum would debit the voided amount as if it
    // were this period's rent.
    const [openChargesRes, periodPaymentsRes, arRes] = await Promise.all([
      fetchChunked(ids, BULK_QUERY_CHUNK_SIZE, (chunk) =>
        db.from('charges').select('lease_id, amount').in('lease_id', chunk).is('voided_at', null).gte('due_date', periodStartStr).lte('due_date', periodEndStr),
        { maxRows: POSTGREST_MAX_ROWS }),
      // Period-paid: manual (check/wire/other) or succeeded ACH payments dated WITHIN this
      // period. Autopay is only authorized to collect THIS period's rent — it must never sweep
      // older, unrelated arrears via an automated ACH debit the tenant didn't specifically
      // authorize for that purpose.
      fetchChunked(ids, BULK_QUERY_CHUNK_SIZE, (chunk) =>
        db.from('payments').select('lease_id, amount, method, stripe_status, autopay_period').in('lease_id', chunk).gte('payment_date', periodStartStr).lte('payment_date', periodEndStr),
        { maxRows: POSTGREST_MAX_ROWS }),
      // Lifetime cap: never debit more than the lease's true outstanding AR balance — however
      // period-scoping above is what prevents re-debiting a tenant who already paid THIS period
      // and what prevents sweeping arrears from an earlier period into an unrelated autopay charge.
      fetchChunked(ids, BULK_QUERY_CHUNK_SIZE, (chunk) => db.from('ar_ledger').select('lease_id, balance').in('lease_id', chunk),
        { maxRows: POSTGREST_MAX_ROWS }),
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
      // Audit 2026-11-12 #1: an in-period ach_stripe row still 'pending'/'processing' (typically a
      // portal payment) is money already moving and reduces what autopay may take, exactly as in
      // the reservation below. This in-memory figure is only the PRE-FILTER that lets a lease the
      // tenant already paid resolve without an RPC; the authoritative amount (which also nets
      // in-flight rows dated outside the period off the balance cap) is computed under the
      // per-lease lock by reserve_autopay_payment().
      // A row stamped for ANOTHER autopay_period (last month's catch-up debit, dated this month)
      // pays that period, not this one — counting it here would skip this period's rent.
      const paidByLease = new Map<string, number>()
      for (const p of periodPaymentsRes.data as { lease_id: string; amount: number; method: string; stripe_status?: string; autopay_period?: string | null }[]) {
        if (p.autopay_period != null && p.autopay_period !== periodStartStr) continue
        const counts = (p.method === 'ach_stripe' && p.stripe_status === 'succeeded') || ['check', 'wire', 'other'].includes(p.method)
        const inFlight = p.method === 'ach_stripe' && (p.stripe_status === 'pending' || p.stripe_status === 'processing')
        if (counts || inFlight) paidByLease.set(p.lease_id, (paidByLease.get(p.lease_id) ?? 0) + Number(p.amount))
      }
      const balanceByLease = new Map<string, number>()
      for (const row of arRes.data as { lease_id: string; balance: number }[]) {
        balanceByLease.set(row.lease_id, row.balance)
      }

      // Resolve EVERY not-yet-collected lease's debit amount now (cheap, in-memory) so
      // zero-debit leases are settled this run regardless of batch position — only leases that
      // actually need a real Stripe call are subject to AUTOPAY_BATCH_LIMIT.
      const needsDebit: typeof notYetCollected = []
      for (const lease of notYetCollected) {
        const periodChargeTotal = chargesByLease.get(lease.id) ?? 0
        const periodPaid = paidByLease.get(lease.id) ?? 0
        const periodOutstanding = Math.max(0, periodChargeTotal - periodPaid)
        const outstandingBalance = balanceByLease.get(lease.id) ?? 0
        const debitAmount = Math.min(periodOutstanding, outstandingBalance)
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
        const notes = `Autopay — ${periodStartStr}`

        // Audit 2026-11-12 #1 / migration 0031: reserve the payments row BEFORE the Stripe call,
        // under the same per-lease advisory lock reserve_payment_intent() (portal ACH) takes. The
        // RPC recomputes the amount from committed state — period charges minus period paid minus
        // in-period in-flight ACH, capped at ar_ledger.balance minus ALL in-flight ACH — so a
        // portal payment still processing is never debited a second time, and a portal payment
        // made while this debit is in flight sees this reservation as in flight. PostgREST runs
        // each RPC in its own transaction, which is why the lock, the read and the insert live in
        // one function. An RPC failure means the state is unknown: never call Stripe.
        const { data: reservationData, error: reserveErr } = await db.rpc('reserve_autopay_payment', {
          p_lease_id: lease.id,
          p_period_start: periodStartStr,
          p_period_end: periodEndStr,
          p_payment_date: new Date().toISOString().slice(0, 10),
          p_notes: notes,
        })
        if (reserveErr || !reservationData) {
          // No debit attempt was made: the lease is still outstanding (`remaining`), and an
          // unknown-state failure answers 500, never a normal 200 (e.g. 0031 not yet applied).
          reservationFailed = true
          autopayErrors++
          remaining++
          errorMessages.push(`autopay lease ${lease.id}: reservation failed, not debited: ${reserveErr?.message ?? 'reserve_autopay_payment returned no result'}`)
          continue
        }
        const reservation = reservationData as AutopayReservation
        if (reservation.outcome === 'existing' || reservation.outcome === 'nothing_due') {
          // existing: a concurrent or earlier run reserved this period after the bulk pre-check.
          // nothing_due: in-flight ACH, or a payment committed since the bulk read, covers it.
          skipped++
          continue
        }
        const amountCents = reservation.amount_cents
        if (reservation.outcome !== 'reserved' || !reservation.payment_id || !reservation.client_request_id
            || typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
          reservationFailed = true
          autopayErrors++
          remaining++
          errorMessages.push(`autopay lease ${lease.id}: reserve_autopay_payment returned an unusable result, not debited: ${JSON.stringify(reservation)}`)
          continue
        }
        const paymentId = reservation.payment_id

        let pi: Stripe.PaymentIntent
        try {
          pi = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'usd',
            customer: tenant.stripe_customer_id,
            payment_method: lease.autopay_payment_method_id,
            payment_method_types: ['us_bank_account'],
            confirm: true,
            off_session: true,
            description: notes,
            // client_request_id lets the webhook (server/lib/stripe-events.ts, OI-233 fallback)
            // find and complete the reservation row if the write-back below never lands.
            metadata: { lease_id: lease.id, tenant_id: tenant.id, client_request_id: reservation.client_request_id, payment_id: paymentId },
          }, {
            // Per RESERVATION (lease + period + the reservation's client_request_id): stripe-node's
            // own retry (maxNetworkRetries) of THIS request replays it instead of debiting twice.
            // Not per period: the reservation row is what stops a second run debiting the period,
            // and a key shared across reservations would make the reservation that follows a
            // released one replay the old failure, or be rejected for changed params
            // (StripeIdempotencyError → indeterminate → a stuck pending row). A new key is only
            // ever minted after a DEFINITIVE failure released the previous reservation, so it
            // cannot duplicate a debit.
            idempotencyKey: `autopay:${lease.id}:${periodStartStr}:${reservation.client_request_id}`,
          })
        } catch (err) {
          autopayErrors++
          // A "definitive" class is trusted only if the PaymentIntent it carries (if any) is not
          // moving money: with a per-reservation key, Stripe idempotency no longer backs up this
          // classification, so a released row next to a live debit would let a later run debit again.
          const errPiStatus = (err as { payment_intent?: { status?: string } }).payment_intent?.status
          const definitive = DEFINITIVE_STRIPE_FAILURES.some((cls) => err instanceof cls)
            && !(errPiStatus && ['processing', 'succeeded', 'requires_capture'].includes(errPiStatus))
          if (!definitive) {
            // Connection / 5xx / idempotency conflict / non-Stripe error: the debit MAY exist.
            // The reservation stays 'pending' with autopay_period set, so it keeps counting as in
            // flight (portal cap) and blocks every later run for this period (alreadyCollected)
            // until the webhook completes it or a human reconciles it (query in 0031). Refusing a
            // possible double debit is the correct failure direction.
            errorMessages.push(`autopay lease ${lease.id}: ${(err as Error).message} — reservation ${paymentId} left pending for reconciliation (debit may exist)`)
            continue
          }
          // Definitive rejection: nothing was debited. Release the reservation: 'failed' (no
          // longer in flight, never counts as paid) and autopay_period cleared so a later run can
          // reserve this period again, as this route did before 0031 (no row on a thrown create).
          // Keep a PaymentIntent id Stripe returns with the error for the audit trail. Guarded to
          // 'pending' so a webhook that already resolved the row wins.
          const stripeErr = err as InstanceType<typeof Stripe.errors.StripeError>
          const piFromError = (stripeErr as { payment_intent?: { id?: string } }).payment_intent?.id ?? null
          const release = (piId: string | null) => db.from('payments')
            .update({ stripe_status: 'failed', stripe_payment_intent_id: piId, autopay_period: null, notes: `${notes} — Stripe ${stripeErr.type}: ${stripeErr.message}` })
            .eq('id', paymentId)
            .in('stripe_status', ['pending'])
            .select('id')
          let { data: released, error: releaseErr } = await release(piFromError)
          // The PI id is audit detail only; if another row already holds it
          // (payments_stripe_pi_uniq), release without it rather than leave the row stuck.
          if (releaseErr?.code === '23505' && piFromError) ({ data: released, error: releaseErr } = await release(null))
          if (releaseErr) {
            errorMessages.push(`autopay lease ${lease.id}: ${stripeErr.message} — reservation ${paymentId} could not be released (${releaseErr.message}); it stays pending and blocks this period until reconciled`)
          } else if (!released || released.length === 0) {
            // Nothing pending to release: the webhook already resolved the row (and owns it now).
            errorMessages.push(`autopay lease ${lease.id}: ${stripeErr.message} — reservation ${paymentId} was already resolved by a webhook; left as is`)
          } else {
            errorMessages.push(`autopay lease ${lease.id}: ${stripeErr.message}`)
          }
          continue
        }

        // Write the PI id + status back onto the reservation. Guarded to rows still
        // pending/processing so a webhook that already advanced the row is never regressed.
        const { error: writeErr } = await db.from('payments')
          .update({ stripe_payment_intent_id: pi.id, stripe_status: pi.status })
          .eq('id', paymentId)
          .in('stripe_status', ['pending', 'processing'])
          .select('id')
        if (writeErr) {
          // The debit is real. The reservation (pending, correct lease/amount/period, its
          // client_request_id in the PI metadata) is the recoverable trace: the webhook completes
          // it, and meanwhile it blocks a second debit. Surface loudly.
          autopayErrors++
          errorMessages.push(`autopay lease ${lease.id}: payment ${pi.id} created but not written back to reservation ${paymentId}: ${writeErr.message}`)
        }
      }
    }
  }

  const errors = chargeErrors + autopayErrors
  // Any of these three means a whole batch failed as a unit, not a per-lease shortfall — that
  // must not look like a normal 200 (OI-162/#1 review round 2 finding #2, round 3 finding #7):
  // the charge-bulk-upsert failing means the ENTIRE portfolio got zero charges this run; a failed
  // autopay pre-check or debit-input lookup means that whole batch got zero debit attempts.
  // reservationFailed (0031): a reserve_autopay_payment call failed or returned garbage, so that
  // lease's state is unknown and it got no debit attempt — the same "never debit blind" class.
  const status = (chargesBulkFailed || voidRecheckFailed || priorAutopayCheckFailed || debitInputsBulkFailed || reservationFailed) ? 500 : 200
  return c.json({ posted, skipped, errors, chargeErrors, autopayErrors, errorMessages, remaining, year, month, voidedSkipped, notStarted, expiredUnbilled, leaseExceptions, frozenByBalanceForward }, status)
})

// Shape returned by reserve_autopay_payment() (supabase/migrations/0031_autopay_reservation.sql).
interface AutopayReservation {
  outcome: 'reserved' | 'existing' | 'nothing_due'
  payment_id?: string
  client_request_id?: string
  amount_cents?: number
}

// Stripe error classes that mean the create was rejected WITHOUT a (charging) PaymentIntent;
// everything else is indeterminate. server/routes/stripe.ts (portal ACH) also treats
// StripeRateLimitError as definitive; here it is NOT: stripe-node retries a connection error once
// (maxNetworkRetries), so a 429 on that retry can follow a first attempt Stripe did execute, and
// releasing the reservation then would leave a live debit with no row that counts it.
const DEFINITIVE_STRIPE_FAILURES = [
  Stripe.errors.StripeInvalidRequestError,
  Stripe.errors.StripeCardError,
  Stripe.errors.StripeAuthenticationError,
  Stripe.errors.StripePermissionError,
]

// OI-047: the recipients only scope the sent_notifications dedup-key set — they do not control
// who receives mail. The actual send recipient is $script:EmailTo in ping-crons-lib.ps1 on the
// ORA laptop (separately maintained). Changing one without the other either has no effect on
// delivery, or records alerts for an address that never gets mail.
// The address lives in the CRIT_ALERT_RECIPIENTS environment variable (comma-separated), not in
// this public repo. It must equal the recipient already stored on sent_notifications rows, or
// every open alert reports once more. Unset fails closed (503); check-deploy-env.mjs requires it.
function critRecipients(env: Env): string[] | null {
  const list = (env.CRIT_ALERT_RECIPIENTS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  return list.length ? list : null
}
const NO_CRIT_RECIPIENTS = 'CRIT_ALERT_RECIPIENTS is not configured'
// OI-321: dedup is keyed on (reference_id, urgency tier, critical date) —
// sent_notifications.alert_tier + alert_date (0019) — so a date alerts again as it escalates
// notice -> warning -> urgent -> overdue, and again after it is edited in place (a lease extended
// by changing end_date). Same four tiers as the critical_dates view's CASE
// (0004_views_and_rls.sql) and the alert_tier CHECK constraint.
const CRIT_TIERS = ['overdue', 'urgent', 'warning', 'notice'] as const
type CritTier = typeof CRIT_TIERS[number]
const isCritTier = (t: unknown): t is CritTier => typeof t === 'string' && (CRIT_TIERS as readonly string[]).includes(t)
// A real calendar date in PostgREST's DATE form (YYYY-MM-DD); 2026-02-30 is rejected.
const isIsoDate = (d: unknown): d is string => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}
const CRIT_ACK_VERSION = 1
// One ack can carry at most this many alerts; a larger set fails closed (400) rather than
// recording part of a digest. Far above any real weekly digest.
const CRIT_ACK_MAX_ALERTS = 5000
const CRIT_ACK_UPSERT_CHUNK = 500
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/cron/critical-dates-alerts
//
// OI-321 (2026-11-09): this handler no longer writes sent_notifications. Before, it recorded the
// dedup rows BEFORE responding (OI-047's dedup-before-send), so when ping-crons.ps1's Outlook-COM
// send then failed the alerts were already marked sent and never fired again. Now it returns the
// digest plus an `ack_token` naming exactly the (reference_id, tier, date) alerts in it; ping-crons.ps1
// POSTs that token to /critical-dates-alerts/ack only after a confirmed send (exit 0). An
// unconfirmed send — failed, unknown (exit 6), or an ack that never arrives — leaves the alerts
// unrecorded, so the next run reports them again: a duplicate, never a loss.
//
// Read-only, so a caller that never acks (e.g. a pinger predating OI-321) gets the same digest
// every run. Never add this endpoint to scripts/delinquency-backup.sh: that job has no send path,
// so it must neither call this nor ack.
cronRouter.post('/critical-dates-alerts', async (c) => {
  const CRIT_RECIPIENTS = critRecipients(c.env)
  if (!CRIT_RECIPIENTS) return c.json({ error: NO_CRIT_RECIPIENTS }, 503)
  const db = getDb(c.env)
  const HORIZON_DAYS = 90
  // Per `.in('reference_id', chunk)` call on the dedup read. The read is filtered to this
  // notification_type, CRIT_RECIPIENTS and the chunk's CURRENT critical dates (legacy untagged
  // rows have a NULL alert_date and drop out), so a chunk returns at most
  // chunk × CRIT_RECIPIENTS.length × CRIT_TIERS.length rows per matching date (UNIQUE
  // (notification_type, reference_id, recipient, alert_tier, alert_date)) — keep that product
  // under POSTGREST_MAX_ROWS or fetchChunked fails every run closed.
  const BULK_QUERY_CHUNK_SIZE = 100

  const horizonDate = new Date()
  horizonDate.setDate(horizonDate.getDate() + HORIZON_DAYS)
  const horizonStr = horizonDate.toISOString().slice(0, 10)

  type CritRow = { date_type: string; reference_id: string; tenant_name: string; property_name: string | null; suite: string | null; critical_date: string; days_until: number; urgency: string }

  // Keyset-paged (fetchAllPages) on reference_id: the view has no lower date bound, so overdue
  // history accumulates and a single select is cut at POSTGREST_MAX_ROWS with no error — every
  // alert past the cap would silently never go out. reference_id is leases.id / insurance_certificates.id
  // (both uuid PKs, one view row each — 0004_views_and_rls.sql), so it is a unique uuid key; the
  // explicit order replaces the view's `ORDER BY days_until`, restored in the digest sort below.
  const { data: criticalDates, error: cdErr } = await fetchAllPages<CritRow>((after) => {
    let q = db.from('critical_dates').select('*').lte('critical_date', horizonStr)
    if (after !== null) q = q.gt('reference_id', after)
    return q.order('reference_id').limit(POSTGREST_MAX_ROWS)
  }, (r) => r.reference_id)

  if (cdErr) return c.json({ error: cdErr.message }, 500)
  if (criticalDates.length === 0) {
    return c.json({ new_alerts: 0, skipped: 0, email: null, ack_token: null })
  }
  // An urgency outside the four tiers could never be acked (alert_tier CHECK), so it would
  // re-alert every run forever. View contract drift must fail loudly instead.
  const badTier = criticalDates.find(r => !isCritTier(r.urgency))
  if (badTier) return c.json({ error: `critical_dates returned an unknown urgency '${String(badTier.urgency)}'` }, 500)
  // Same reasoning for the date half of the key (the ack rejects a non-calendar date).
  const badDate = criticalDates.find(r => !isIsoDate(r.critical_date))
  if (badDate) return c.json({ error: `critical_dates returned a malformed critical_date '${String(badDate.critical_date)}'` }, 500)

  // Dedup: which (reference_id, tier, date) alerts this recipient already got. Chunked
  // (fetchChunked) so the `.in()` URL stays bounded, and fails closed on an error or a capped
  // chunk: a truncated or failed read makes acked alerts look new and re-sends them.
  const refIds = criticalDates.map(r => r.reference_id)
  const dateByRef = new Map(criticalDates.map(r => [r.reference_id, r.critical_date]))
  const { data: alreadySent, error: sentErr } = await fetchChunked<{ reference_id: string; recipient: string; alert_tier: string | null; alert_date: string | null }>(
    refIds, BULK_QUERY_CHUNK_SIZE,
    (chunk) => db.from('sent_notifications')
      .select('reference_id, recipient, alert_tier, alert_date')
      .eq('notification_type', 'critical_date_alert')
      .in('recipient', CRIT_RECIPIENTS)
      .in('reference_id', chunk)
      .in('alert_date', [...new Set(chunk.map(id => dateByRef.get(id)!))]),
    { maxRows: POSTGREST_MAX_ROWS }
  )
  if (sentErr) return c.json({ error: `Failed to read sent notifications: ${sentErr.message}` }, 500)

  // A legacy row (untagged: recorded before 0019 and not backfilled because its date had left
  // the view) matches no (tier, date), so it suppresses nothing.
  const key = (ref: string, rec: string, tier: string, date: string) => `${ref}|${rec}|${tier}|${date}`
  const sentSet = new Set(alreadySent.filter(s => s.alert_tier !== null && s.alert_date !== null)
    .map(s => key(s.reference_id, s.recipient, s.alert_tier!, s.alert_date!)))
  const newAlerts: CritRow[] = criticalDates.filter(r =>
    CRIT_RECIPIENTS.some(rec => !sentSet.has(key(r.reference_id, rec, r.urgency, r.critical_date)))
  )

  if (newAlerts.length === 0) {
    return c.json({ new_alerts: 0, skipped: criticalDates.length, email: null, ack_token: null })
  }

  // Build email digest
  const urgencyOrder: Record<string, number> = { overdue: 0, urgent: 1, warning: 2, notice: 3 }
  const sorted = [...newAlerts].sort((a, b) => ((urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9)) || (a.days_until - b.days_until))

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

  // Opaque to the caller, which posts it back verbatim to /ack. Ids, tiers and dates only, no
  // tenant data.
  const ack_token = JSON.stringify({ v: CRIT_ACK_VERSION, alerts: newAlerts.map(r => [r.reference_id, r.urgency, r.critical_date]) })

  return c.json({
    new_alerts: newAlerts.length,
    skipped: criticalDates.length - newAlerts.length,
    email: { subject, body: bodyText },
    ack_token,
  })
})

// POST /api/cron/critical-dates-alerts/ack  { "ack_token": "<token from /critical-dates-alerts>" }
//
// OI-321: records the dedup rows for a digest ping-crons.ps1 confirmed it sent. Idempotent
// (ON CONFLICT DO NOTHING), so a retried ack is harmless. Validates the whole token before
// writing anything; a token it cannot fully parse is a 400 and records nothing.
cronRouter.post('/critical-dates-alerts/ack', async (c) => {
  const CRIT_RECIPIENTS = critRecipients(c.env)
  if (!CRIT_RECIPIENTS) return c.json({ error: NO_CRIT_RECIPIENTS }, 503)
  let raw: unknown
  try { raw = await c.req.json() } catch { return c.json({ error: 'body is not JSON' }, 400) }
  const tokenStr = (raw as { ack_token?: unknown } | null)?.ack_token
  if (typeof tokenStr !== 'string') return c.json({ error: 'ack_token (string) is required' }, 400)
  let token: unknown
  try { token = JSON.parse(tokenStr) } catch { return c.json({ error: 'ack_token is not valid' }, 400) }
  const { v, alerts } = (token ?? {}) as { v?: unknown; alerts?: unknown }
  if (v !== CRIT_ACK_VERSION) return c.json({ error: 'ack_token version is not supported' }, 400)
  if (!Array.isArray(alerts) || alerts.length === 0) return c.json({ error: 'ack_token carries no alerts' }, 400)
  if (alerts.length > CRIT_ACK_MAX_ALERTS) return c.json({ error: `ack_token carries more than ${CRIT_ACK_MAX_ALERTS} alerts` }, 400)
  const acked: [string, CritTier, string][] = []
  for (const a of alerts) {
    if (!Array.isArray(a) || a.length !== 3 || typeof a[0] !== 'string' || !UUID_RE.test(a[0]) || !isCritTier(a[1]) || !isIsoDate(a[2])) {
      return c.json({ error: 'ack_token carries a malformed alert' }, 400)
    }
    acked.push([a[0], a[1], a[2]])
  }

  const rows = acked.flatMap(([reference_id, alert_tier, alert_date]) =>
    CRIT_RECIPIENTS.map(recipient => ({ notification_type: 'critical_date_alert', reference_id, recipient, alert_tier, alert_date })))
  const db = getDb(c.env)
  for (let i = 0; i < rows.length; i += CRIT_ACK_UPSERT_CHUNK) {
    const { error: ackErr } = await db.from('sent_notifications')
      .upsert(rows.slice(i, i + CRIT_ACK_UPSERT_CHUNK), { onConflict: 'notification_type,reference_id,recipient,alert_tier,alert_date', ignoreDuplicates: true })
    if (ackErr) return c.json({ error: `Failed to record notifications: ${ackErr.message}` }, 500)
  }
  return c.json({ recorded: acked.length })
})

cronRouter.post('/delinquency-check', async (c) => {
  const db = getDb(c.env)
  const today = new Date().toISOString().slice(0, 10)
  const [year, month] = today.split('-')
  const periodStart = `${year}-${month}-01`
  const GRACE_DAYS = 30
  const LATE_FEE_AMOUNT = 50 // $50 flat late fee — adjust as needed
  const BULK_QUERY_CHUNK_SIZE = 100
  // OI-278: a payment row dated inside this window is the evidence that the payments feed is live.
  const PAYMENTS_FEED_LOOKBACK_DAYS = 45
  const PAYMENTS_FEED_ABSENT_LEAD = 'PAYMENTS FEED ABSENT — delinquency not reliable; no late fees posted'
  // Late-fee off switch (2026-11-13). Payments start being recorded before every lease has its
  // balance-forward credit from QuickBooks; the first recorded payment lifts the feed-absent guard
  // below, and every lease would then look delinquent on its lifetime charges (OI-278 again). So
  // late fees post only when LATE_FEES_ENABLED is exactly 'true'; anything else, unset included,
  // reports the delinquency list without posting. Turn it on once app balances match QuickBooks.
  const lateFeesDisabled = c.env.LATE_FEES_ENABLED !== 'true'
  const LATE_FEES_DISABLED_LEAD = 'LATE FEES OFF (LATE_FEES_ENABLED is not "true") — no late fees posted'

  // OI-278 (2026-09-12): ar_ledger.balance = Σcharges − Σqualifying payments (migration 0010), so
  // with NO payments recorded every lease's balance is its lifetime charge total and every lease
  // past GRACE_DAYS looks delinquent — the live payments table had 0 rows ever, and this endpoint
  // posted 68 $50 late fees against tenants who had never been recorded as paying. Fail CLOSED:
  // if no QUALIFYING payment is dated inside [today − PAYMENTS_FEED_LOOKBACK_DAYS, today], post
  // zero fees. The delinquency list is still computed and returned (flagged) so the digest shows
  // what WOULD have fired.
  //   - "Qualifying" = the SAME predicate ar_ledger's payment_totals sums (migration 0010, copied
  //     verbatim by 0011): check/wire/other always; ach_stripe only when stripe_status='succeeded'.
  //     Autopay (monthly-billing above) inserts ach_stripe rows as `processing` on the 1st and the
  //     portal (stripe.ts) inserts intents as pending; if those later fail/return they never reduce
  //     total_paid, so counting ANY row would lift the guard against balances that never moved.
  //   - Upper bound `today`: a future-dated typo must not read as a live feed.
  //   - payment_date (indexed, the business date the period-paid lookup in monthly-billing also
  //     filters on) rather than created_at — a backfill of old payments is not a live feed.
  const lookbackDate = new Date()
  lookbackDate.setDate(lookbackDate.getDate() - PAYMENTS_FEED_LOOKBACK_DAYS)
  const lookbackStr = lookbackDate.toISOString().slice(0, 10)
  const { data: recentPayments, error: payErr } = await db
    .from('payments')
    .select('id')
    .or('method.in.(check,wire,other),and(method.eq.ach_stripe,stripe_status.eq.succeeded)')
    .gte('payment_date', lookbackStr)
    .lte('payment_date', today)
    .limit(1)
  // A failed probe is unknown feed state, not "absent" — same fail-the-request convention as arErr.
  if (payErr) return c.json({ error: payErr.message }, 500)
  const paymentsFeedAbsent = !recentPayments || recentPayments.length === 0

  // Build the delinquency digest — OI-047 (2026-08-04): return it instead of emailing via Resend;
  // ping-crons.ps1 sends it via Outlook COM, and ONLY when `email` is non-null. Live feed with
  // nothing delinquent → null (unchanged). OI-278: when the feed is absent, ALWAYS return a
  // flagged email — even with 0 delinquent leases — so the operator is told the feed is dead
  // before anything crosses the grace window, not after. Subject and body both LEAD with the
  // warning so the digest can't be read as a real delinquency list (the balances are
  // unreliable by construction).
  const buildEmail = (delinquent: { tenant_name: string; property: string; balance: number }[], lateFeesPosted: number): { subject: string; body: string } | null => {
    if (delinquent.length === 0 && !paymentsFeedAbsent) return null
    const lines = delinquent.map(d => `  • ${d.tenant_name} | ${d.property} | Balance: $${d.balance.toFixed(2)}`)
    const lead = (paymentsFeedAbsent ? `${PAYMENTS_FEED_ABSENT_LEAD}\n\n` : '') + (lateFeesDisabled ? `${LATE_FEES_DISABLED_LEAD}\n\n` : '')
    const listing = lines.length > 0 ? lines.join('\n') : '  (no leases past the grace window)'
    const bodyText = `${lead}ORA PM — Delinquency Report\n${today}\n\n${listing}\n\nLate fees posted: ${lateFeesPosted}\nhttps://ora-pm.pages.dev/ar`
    const baseSubject = `[ORA PM] ${delinquent.length} Delinquent Tenant${delinquent.length === 1 ? '' : 's'} — ${today}`
    const subject = paymentsFeedAbsent ? `${PAYMENTS_FEED_ABSENT_LEAD} — ${baseSubject}`
      : lateFeesDisabled ? `${LATE_FEES_DISABLED_LEAD} — ${baseSubject}` : baseSubject
    return { subject, body: bodyText }
  }

  // Fetch AR ledger rows with a positive balance — keyset-paged on lease_id (ar_ledger is one row
  // per lease). A single select is cut at POSTGREST_MAX_ROWS with no error: every positive-balance
  // lease past the cap would silently get no late fee and be missing from the digest.
  const { data: arRows, error: arErr } = await fetchAllPages((after) => {
    let q = db.from('ar_ledger').select('*').gt('balance', 0)
    if (after !== null) q = q.gt('lease_id', after)
    return q.order('lease_id').limit(POSTGREST_MAX_ROWS)
  }, (row) => row.lease_id)

  if (arErr) return c.json({ error: arErr.message }, 500)
  if (!arRows || arRows.length === 0) return c.json({ late_fees_posted: 0, delinquent_count: 0, payments_feed_absent: paymentsFeedAbsent, late_fees_enabled: !lateFeesDisabled, email: buildEmail([], 0) })

  type ARRow = { lease_id: string; tenant_id: string; tenant_name: string; property_name: string | null; suite: string | null; balance: number; balance_forward?: number | string | null; balance_forward_as_of?: string | null }

  // GRACE_DAYS cutoff is the same for every row — compute once.
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - GRACE_DAYS)
  const cutoffStr = cutoffDate.toISOString().slice(0, 10)

  // Bulk lookups (2026-08-17 fix): the prior version ran these two lookups per lease inside the
  // loop below — up to 2 sequential Supabase round-trips per AR row, which reliably exceeded
  // ping-crons.ps1's 240s client timeout once the AR set grew past ~30-40 rows (live-confirmed
  // 2026-08-17 at 68 rows: Cloudflare logged the invocation itself as `Canceled`, still running,
  // no error). Chunked via fetchChunked at BULK_QUERY_CHUNK_SIZE ids per `.in()` call, same
  // pattern as monthly-billing above — 2 bulk queries total instead of up to 2*N.
  //
  // OI-234 (ruled 2026-09-12, "Oldest-first"): the first lookup used to be an EXISTENCE probe —
  // "does this lease have any charge with due_date <= cutoff" — so any positive-balance lease
  // with an old charge was fined even when that old charge was fully paid (a tenant current on
  // every old invoice and owing only this month's not-yet-overdue rent got the $50 fee).
  // Payments now apply to the oldest charges first (standard AR aging):
  //     recent_i  = Σ charges.amount for lease i with due_date >  cutoffStr
  //     overdue_i = ar_ledger.balance_i − recent_i
  //     delinquent iff overdue_i > OVERDUE_EPSILON
  // `recent_i` must be summed over EXACTLY the charge population ar_ledger.balance counts. The
  // live view (supabase/migrations/0016_charges_void.sql, verbatim from 0011/0010 plus one
  // filter) sums every `charges` row for the lease WHERE voided_at IS NULL — no type/status
  // filter (amount is NUMERIC(12,2) US dollars, CHECK >= 0), so the only filters applied here are
  // that same `.is('voided_at', null)` and the due_date split. A late fee posted this month has
  // due_date = today, so it is always "recent" and can never make itself overdue.
  //
  // OI-278 / migration 0016, existing-fee guard (second query below) — DELIBERATELY NOT filtered
  // on voided_at: a voided fee for a lease-month still occupies the unique idempotency_key
  // `late_fee_<lease>_<year>_<month>`, so re-posting that month would 23505 regardless; counting
  // voided rows here means a month whose fee was voided is treated as already handled. That is
  // the conservative choice — never re-fee a voided month.
  //
  // Row cap (PR #27 refute review): PostgREST returns at most `max_rows` (POSTGREST_MAX_ROWS) per
  // request and says nothing when it truncates. Before OI-234 a truncated existence probe could only
  // MISS a fee; a truncated SUM understates recent_i, overstates overdue_i and FINES A CURRENT
  // TENANT. A chunk that reaches the cap cannot be told apart from a complete one, so fetchChunked's
  // `maxRows` fails the whole run closed (500, retried next run) rather than post from a
  // possibly-partial sum. Bounded in practice: only charges due in the last GRACE_DAYS (plus any
  // future-dated ones), ~2-3 per lease. The existing-fee guard is <= 1 row per lease per month
  // (unique idempotency_key); a dropped row there would re-attempt a fee already posted (the
  // idempotency_key index and the 23505 branch below are the only backstop), so it is row-cap
  // guarded too.
  const leaseIds = (arRows as ARRow[]).map((ar) => ar.lease_id)
  const [recentRes, existingFeeRes] = await Promise.all([
    fetchChunked(leaseIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
      db.from('charges').select('lease_id, amount').in('lease_id', chunk).is('voided_at', null).gt('due_date', cutoffStr),
      { maxRows: POSTGREST_MAX_ROWS }),
    fetchChunked(leaseIds, BULK_QUERY_CHUNK_SIZE, (chunk) =>
      db.from('charges').select('lease_id').in('lease_id', chunk).eq('type', 'late_fee').gte('charge_date', periodStart),
      { maxRows: POSTGREST_MAX_ROWS }),
  ])

  // Intentional behavior change from the pre-fix code, not just a mechanical batching swap: the
  // old per-row queries never checked their own error at all (`const { data } = await db...`), so
  // a query failure silently fell through the `!data || data.length === 0` guard and just skipped
  // that one lease — under-reporting delinquency without surfacing it. These bulk checks fail the
  // whole request closed instead, matching this function's own top-level `arErr` convention above
  // (never report a delinquency digest built from partially-unknown data).
  // Prefixed with the lookup name: fetchChunked's row-cap message is the same for both queries.
  if (recentRes.error) return c.json({ error: `recent-charges: ${recentRes.error.message}` }, 500)
  if (existingFeeRes.error) return c.json({ error: `existing-fee: ${existingFeeRes.error.message}` }, 500)

  // Σ recent charges per lease, in memory. `Number(...)` because PostgREST may serialize NUMERIC
  // as a JSON string depending on client/config — a string here would concatenate, not add. A
  // non-finite amount is a data-integrity fault, not a zero: fail closed like the query errors.
  const recentByLease = new Map<string, number>()
  for (const r of recentRes.data as { lease_id: string; amount: number | string }[]) {
    const amt = Number(r.amount)
    if (!Number.isFinite(amt)) return c.json({ error: `non-numeric charges.amount for lease ${r.lease_id}` }, 500)
    recentByLease.set(r.lease_id, (recentByLease.get(r.lease_id) ?? 0) + amt)
  }
  const existingFeeLeaseIds = new Set((existingFeeRes.data as { lease_id: string }[]).map((r) => r.lease_id))

  // 0030: ar_ledger.balance includes the lease's balance forward from QuickBooks. A positive one is
  // owed as of its as_of date, like a charge due then: when that date is inside the grace window it
  // is "recent" too. (A negative one is a credit and simply lowers the balance.)
  for (const ar of arRows as ARRow[]) {
    const bf = Number(ar.balance_forward ?? 0)
    if (!Number.isFinite(bf)) return c.json({ error: `non-numeric ar_ledger.balance_forward for lease ${ar.lease_id}` }, 500)
    if (bf > 0 && typeof ar.balance_forward_as_of === 'string' && ar.balance_forward_as_of > cutoffStr) {
      recentByLease.set(ar.lease_id, (recentByLease.get(ar.lease_id) ?? 0) + bf)
    }
  }

  // Half-cent tolerance: balances and amounts are 2dp NUMERIC in Postgres but arrive as IEEE
  // doubles, and the subtraction can leave ~1e-13 of noise — never fine a tenant over noise.
  const OVERDUE_EPSILON = 0.005

  let lateFeesPosted = 0
  const delinquentLeases: { tenant_name: string; property: string; balance: number }[] = []

  for (const ar of arRows as ARRow[]) {
    const overdue = Number(ar.balance) - (recentByLease.get(ar.lease_id) ?? 0)
    if (!(overdue > OVERDUE_EPSILON)) continue

    // OI-278: with the payments feed absent, report the lease but never post the fee. Same when
    // late fees are switched off.
    if (existingFeeLeaseIds.has(ar.lease_id) || paymentsFeedAbsent || lateFeesDisabled) {
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

  // Late fees above are already posted (or not) by this point regardless of what happens to the
  // digest — unchanged from today's behavior (buildEmail is defined above the AR fetch).
  const email = buildEmail(delinquentLeases, lateFeesPosted)

  return c.json({ late_fees_posted: lateFeesPosted, delinquent_count: delinquentLeases.length, payments_feed_absent: paymentsFeedAbsent, late_fees_enabled: !lateFeesDisabled, email })
})
