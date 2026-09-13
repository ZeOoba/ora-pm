import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

// ---------------------------------------------------------------------------
// Mock server/lib/stripe — controllable stub (same pattern as stripe.test.ts)
// ---------------------------------------------------------------------------
const mockStripe = {
  paymentIntents: {
    create: vi.fn(),
  },
}

vi.mock('../../server/lib/stripe', () => ({
  getStripe: vi.fn(() => mockStripe),
}))

// checkRateLimit is now applied to /api/cron/* (OI-038 remainder) — mocked to
// always allow, same pattern as tests/routes/stripe.test.ts, so this file's
// many sequential postBilling() calls across its test cases don't trip the
// module-scope in-memory fallback's fixed window (no RATE_LIMIT_KV in test env).
vi.mock('../../server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}))

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js — stateful, arg-aware mock.
//
// OI-162/#1 round 2 (2026-08-16, post-adversarial-review): charges are
// posted via ONE bulk `.upsert(rows, { onConflict, ignoreDuplicates }).select()`
// call, the autopay prior-period pre-check is ONE bulk `.in().eq()` query,
// and — new in round 2 — the per-eligible-lease debit inputs (open charges,
// period-paid, ar_ledger balance) are ALSO bulk `.in(lease_id, ids)` queries
// across a bounded batch (AUTOPAY_BATCH_LIMIT), not one query per lease.
//
// `state.charges` is the SINGLE simulated charges table, mutated by the
// upsert mock and read back by the bulk open-charges query — so these tests
// prove step 1's writes are what step 3 actually reads, not two independent
// fixtures that happen to agree (an adversarial-review-caught gap in round 1's
// tests). ON CONFLICT (idempotency_key) DO NOTHING is simulated by checking
// membership before appending, mirroring real PostgREST `Prefer:
// return=representation` semantics (only actually-inserted rows return).
//
// `state.payments` is a real in-memory payments table: the autopay pre-check
// (bulk `.in().eq()`), the period-paid lookup (bulk `.in().gte().lte()`), and
// payments.insert() all operate on it directly — invoking the handler twice
// genuinely reflects run 1's recorded payment in run 2.
//
// Arrears (charges outside the current period's due_date range) are seeded directly into
// state.charges with an explicit out-of-period due_date — the SAME array the in-period rent/CAM
// charges live in, so the bulk open-charges query's date filter (not just a separate fixture) is
// what actually excludes them. `ar_ledger.balance` is computed the same way migration 0011's view
// does: total charged (lifetime, no date scoping) minus payments that count as paid.
// ---------------------------------------------------------------------------
const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

type PaymentRow = {
  lease_id: string
  amount: number
  method: string
  stripe_status?: string
  autopay_period?: string
  payment_date?: string
}

type ChargeRow = {
  lease_id: string
  idempotency_key: string
  amount: number
  due_date: string
  [key: string]: unknown
}

const upsertChargesSpy = vi.hoisted(() => vi.fn())
const inPaymentsSpy = vi.hoisted(() => vi.fn())
const inChargesSpy = vi.hoisted(() => vi.fn())
const inArLedgerSpy = vi.hoisted(() => vi.fn())

const state = {
  leases: [] as Record<string, unknown>[],
  // state.charges is the ONE simulated charges table — in-period rent/CAM (posted by step 1's
  // upsert mock) AND out-of-period arrears (hand-seeded by a test with an explicit due_date
  // outside the current period) live in the SAME array, distinguished only by due_date — exactly
  // like the real table. The bulk open-charges query (step 3) filters this by due_date range for
  // real, closing round-2 review finding #4 (mutating the date bounds away used to still pass).
  charges: [] as ChargeRow[],
  payments: [] as PaymentRow[],
  chargesUpsertError: null as { code?: string; message: string } | null,
  paymentsInsertError: null as { code?: string; message: string } | null,
  priorAutopayCheckError: null as { code?: string; message: string } | null,
  debitInputsError: null as { code?: string; message: string } | null,
  arLedgerPaddingRows: 0,
}

function paymentCounts(p: PaymentRow): boolean {
  if (p.method === 'ach_stripe' && p.stripe_status === 'succeeded') return true
  return ['check', 'wire', 'other'].includes(p.method)
}

// Mirrors migration 0011's ar_ledger view: lifetime totals per lease, no date scoping — sums
// EVERY charge regardless of due_date (unlike the step-3 open-charges query, which is period-scoped).
function ledgerBalance(leaseId: string): number {
  const chargedTotal = state.charges.filter(c => c.lease_id === leaseId).reduce((s, c) => s + c.amount, 0)
  const paidTotal = state.payments.filter(p => p.lease_id === leaseId && paymentCounts(p)).reduce((s, p) => s + p.amount, 0)
  return chargedTotal - paidTotal
}
// Back-compat helper for tests written against a single lease ('lease_1').
function ledgerBalanceLease1(): number {
  return ledgerBalance('lease_1')
}

// PostgREST's `max_rows` (supabase/config.toml, 1000): every SELECT response is silently cut to
// this many rows, with no error and no marker. Every read path in this mock applies it, so a
// handler that trusts a response's length as "complete" fails these tests the way it would in
// production — not only when a test happens to hand it exactly 1000 rows.
const PG_MAX_ROWS = 1000
const capped = <T>(rows: T[]): T[] => rows.slice(0, PG_MAX_ROWS)

// `leases` builder: records `.eq`/`.gt`/`.order`/`.limit` and applies them at `await` (the
// builder is thenable at any point, like supabase-js), then applies the row cap. A keyset-paged
// handler (`.gt('id', last).order('id').limit(n)`) and the pre-fix single `.select().eq()` both
// run against the same honest table.
const leasesPageSpy = vi.hoisted(() => vi.fn())
function leasesTable() {
  const calls: { method: string; args: unknown[] }[] = []
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gt', 'order', 'limit']) {
    b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b }
  }
  b.then = (resolve: (v: unknown) => void) => {
    leasesPageSpy(calls)
    let rows = [...state.leases] as { id: string }[]
    for (const c of calls) {
      if (c.method === 'gt') rows = rows.filter(r => (r as Record<string, unknown>)[c.args[0] as string] as string > (c.args[1] as string))
    }
    const order = calls.find(c => c.method === 'order')
    if (order) {
      const key = (r: unknown) => String((r as Record<string, unknown>)[order.args[0] as string])
      rows.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)) // bytewise, like uuid ordering
    }
    const limit = calls.find(c => c.method === 'limit')
    if (limit) rows = rows.slice(0, limit.args[0] as number)
    return resolve({ data: capped(rows), error: null })
  }
  return b
}

function installDbMock() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'leases') return leasesTable()
    if (table === 'charges') {
      return {
        // Step 1: bulk upsert — simulates INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
        // RETURNING idempotency_key. Writes into state.charges, the SAME store step 3's bulk
        // open-charges query below reads from.
        upsert: vi.fn().mockImplementation((rows: ChargeRow[]) => ({
          select: upsertChargesSpy.mockImplementation(async () => {
            if (state.chargesUpsertError) return { data: null, error: state.chargesUpsertError }
            const inserted: { idempotency_key: string }[] = []
            for (const row of rows) {
              if (!state.charges.some(c => c.idempotency_key === row.idempotency_key)) {
                state.charges.push(row)
                inserted.push({ idempotency_key: row.idempotency_key })
              }
            }
            return { data: inserted, error: null }
          }),
        })),
        // Step 3: bulk open-charges lookup — .in('lease_id', ids).gte('due_date',y).lte('due_date',z)
        // Filters by the ACTUAL due_date bounds, not just lease_id — a charge outside the period
        // (arrears) must not appear here even though it's in the same state.charges array as the
        // in-period ones (round-2 review finding #4: removing this date filter used to still pass).
        select: vi.fn().mockReturnValue({
          in: inChargesSpy.mockImplementation((_col: string, leaseIds: string[]) => ({
            gte: vi.fn().mockImplementation((gteCol: string, gteVal: string) => ({
              lte: vi.fn().mockImplementation(async (lteCol: string, lteVal: string) => {
                if (state.debitInputsError) return { data: null, error: state.debitInputsError }
                return {
                  data: capped(state.charges
                    .filter(c =>
                      leaseIds.includes(c.lease_id) &&
                      gteCol === 'due_date' && lteCol === 'due_date' &&
                      c.due_date >= gteVal && c.due_date <= lteVal
                    )
                    .map(c => ({ lease_id: c.lease_id, amount: c.amount }))),
                  error: null,
                }
              }),
            })),
          })),
        }),
      }
    }
    if (table === 'payments') {
      return {
        select: vi.fn().mockReturnValue({
          in: inPaymentsSpy.mockImplementation((col: string, leaseIds: string[]) => ({
            // Step 2: bulk prior-autopay pre-check — .in('lease_id',[...]).eq('autopay_period',y)
            eq: vi.fn().mockImplementation(async (col2: string, val2: string) => {
              if (state.priorAutopayCheckError) return { data: null, error: state.priorAutopayCheckError }
              return {
                data: capped(state.payments
                  .filter(p => col === 'lease_id' && leaseIds.includes(p.lease_id) && col2 === 'autopay_period' && p.autopay_period === val2)
                  .map(p => ({ lease_id: p.lease_id }))),
                error: null,
              }
            }),
            // Step 3: bulk period-paid lookup — .in('lease_id',[...]).gte('payment_date',y).lte('payment_date',z)
            gte: vi.fn().mockImplementation((gteCol: string, gteVal: string) => ({
              lte: vi.fn().mockImplementation(async (lteCol: string, lteVal: string) => {
                if (state.debitInputsError) return { data: null, error: state.debitInputsError }
                return {
                  data: capped(state.payments.filter(p =>
                    col === 'lease_id' && leaseIds.includes(p.lease_id) &&
                    gteCol === 'payment_date' && lteCol === 'payment_date' &&
                    p.payment_date !== undefined && p.payment_date >= gteVal && p.payment_date <= lteVal
                  )),
                  error: null,
                }
              }),
            })),
          })),
        }),
        insert: vi.fn().mockImplementation(async (row: PaymentRow) => {
          if (state.paymentsInsertError) return { error: state.paymentsInsertError }
          state.payments.push(row)
          return { error: null }
        }),
      }
    }
    if (table === 'ar_ledger') {
      return {
        select: vi.fn().mockReturnValue({
          // Step 3: bulk balance lookup — .in('lease_id', ids)
          in: inArLedgerSpy.mockImplementation(async (_col: string, leaseIds: string[]) => {
            if (state.debitInputsError) return { data: null, error: state.debitInputsError }
            // ar_ledger is one row per lease, so a real chunk of <= 100 ids can't reach the cap;
            // `arLedgerPaddingRows` injects foreign rows AHEAD of the real ones to exercise the
            // guard anyway (defence in depth if the view ever stops being one-row-per-lease).
            const padding = Array.from({ length: state.arLedgerPaddingRows }, (_, i) => ({ lease_id: `pad_${i}`, balance: 0 }))
            return {
              data: capped([...padding, ...leaseIds.map((id: string) => ({ lease_id: id, balance: ledgerBalance(id) }))]),
              error: null,
            }
          }),
        }),
      }
    }
    return { select: vi.fn() }
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const AUTOPAY_LEASE = {
  id: 'lease_1',
  tenant_id: 't1',
  base_rent_monthly: 5000,
  cam_estimate_monthly: 0,
  start_date: '2025-01-01',
  autopay_enabled: true,
  autopay_payment_method_id: 'pm_bank_1',
  tenants: { id: 't1', stripe_customer_id: 'cus_1' },
}

function autopayLease(id: string, rent = 5000) {
  return {
    id,
    tenant_id: `t_${id}`,
    base_rent_monthly: rent,
    cam_estimate_monthly: 0,
    start_date: '2025-01-01',
    autopay_enabled: true,
    autopay_payment_method_id: 'pm_bank_1',
    tenants: { id: `t_${id}`, stripe_customer_id: `cus_${id}` },
  }
}

function nonAutopayLease(id: string, rent = 4000) {
  return {
    id,
    tenant_id: `t_${id}`,
    base_rent_monthly: rent,
    cam_estimate_monthly: 0,
    start_date: '2025-01-01',
    autopay_enabled: false,
    autopay_payment_method_id: null,
    tenants: { id: `t_${id}`, stripe_customer_id: null },
  }
}

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()

function postBilling() {
  return app.request('/api/cron/monthly-billing?year=2026&month=6', {
    method: 'POST',
    headers: { Authorization: 'Bearer test' },
  }, env)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.leases = [AUTOPAY_LEASE]
  state.charges = []
  state.payments = []
  state.chargesUpsertError = null
  state.paymentsInsertError = null
  state.priorAutopayCheckError = null
  state.debitInputsError = null
  state.arLedgerPaddingRows = 0
  installDbMock()
  mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_auto_1', status: 'processing' })
})

// ---------------------------------------------------------------------------
// POST /api/cron/monthly-billing — autopay idempotency + balance cap (OI-034)
// ---------------------------------------------------------------------------
describe('POST /api/cron/monthly-billing', () => {
  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/monthly-billing', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  // RED 1 — re-run of the same period must not create a second debit
  it('creates only one PaymentIntent across two runs of the same period', async () => {
    const res1 = await postBilling()
    expect(res1.status).toBe(200)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)

    // Run 2: run 1's payments row (autopay_period stamped) and charge (idempotency_key) both
    // now exist in state, driving the SAME bulk-mock code path run 1 used.
    const res2 = await postBilling()
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { skipped: number; errors: number }

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(body2.errors).toBe(0)
    // charge upsert skip (already-posted idempotency_key) + autopay skip (already collected)
    expect(body2.skipped).toBe(2)
  })

  // RED 2 — deterministic Stripe idempotency key as second argument
  it('passes idempotencyKey autopay:<leaseId>:<periodStart> to paymentIntents.create', async () => {
    const res = await postBilling()
    expect(res.status).toBe(200)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500000, currency: 'usd' }),
      expect.objectContaining({ idempotencyKey: 'autopay:lease_1:2026-06-01' }),
    )
  })

  // RED 3 — fully paid period: no PaymentIntent, lease counted as skipped
  it('skips a lease whose period charges are already fully paid manually', async () => {
    state.payments = [{ lease_id: 'lease_1', amount: 5000, method: 'check' }]

    const res = await postBilling()
    expect(res.status).toBe(200)
    const body = await res.json() as { posted: number; skipped: number; errors: number }

    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(body.skipped).toBe(1) // the autopay skip (charge upsert posted fresh)
    expect(body.errors).toBe(0)
  })

  // RED 4 — partial manual payment: debit only the outstanding balance
  it('debits min(period charges, outstanding balance) after a partial manual payment', async () => {
    state.payments = [{ lease_id: 'lease_1', amount: 2000, method: 'check' }]

    const res = await postBilling()
    expect(res.status).toBe(200)

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 300000 }), // $3,000 in cents, not $5,000
      expect.anything(),
    )
  })

  // Race: concurrent run wins the payments insert → 23505 counted as skipped
  it('treats a 23505 on the payments insert as skipped, not an error', async () => {
    state.paymentsInsertError = { code: '23505', message: 'duplicate key value violates unique constraint "payments_autopay_period_uniq"' }

    const res = await postBilling()
    expect(res.status).toBe(200)
    const body = await res.json() as { skipped: number; errors: number; errorMessages: string[] }

    expect(body.errors).toBe(0)
    expect(body.errorMessages).toEqual([])
    expect(body.skipped).toBe(1)
  })

  // RED 5 — the balance cap must be PERIOD-scoped, not lifetime (REFUTE finding,
  // 2026-08-03): ar_ledger.balance is a lifetime total. A tenant with old,
  // unresolved arrears who pays THIS period's rent in full manually must not
  // be auto-debited for the old arrears — that's outside what autopay was
  // authorized to collect for this period, and contradicts this file's own
  // "already paid manually must not be re-debited" guarantee.
  it('does not sweep prior-period arrears when the current period is paid in full manually', async () => {
    // Unpaid arrears from a prior period — due_date OUTSIDE the current period (2026-06),
    // so step 3's date-scoped open-charges query must exclude it from periodChargeTotal even
    // though it's the same lease and the same simulated table as the in-period rent charge.
    state.charges = [{ lease_id: 'lease_1', idempotency_key: 'arrears-1', amount: 500, due_date: '2026-04-05' }]
    state.payments = [{ lease_id: 'lease_1', amount: 5000, method: 'check', payment_date: '2026-06-15' }]

    const res = await postBilling()
    expect(res.status).toBe(200)

    // Lifetime balance is still $500 (arrears never collected elsewhere) —
    // proves this is a period-scoping fix, not a "credit balance" false pass.
    expect(ledgerBalanceLease1()).toBe(500)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  // Positive-balance variant of "does not sweep prior-period arrears" above: arrears exist AND
  // are paid off by an out-of-period payment, current-period rent is untouched by either. Full
  // rent must still be debited. NOTE (round-4 review): this does NOT independently kill the
  // unbounded-date-window mutation on its own — under that mutation periodChargeTotal ($5,500)
  // and periodPaid (also picking up the $500 out-of-period payment) both grow by $500 and cancel
  // out, landing on the same $5,000 debit for the wrong reason. The sibling test above ("does not
  // sweep prior-period arrears...") is the one that actually catches that mutation (its lifetime-
  // balance assertion diverges). Kept as a real scenario worth covering, not as mutation coverage.
  it('debits the full current-period rent even with unpaid prior-period arrears and an unrelated out-of-period payment', async () => {
    state.charges = [{ lease_id: 'lease_1', idempotency_key: 'arrears-1', amount: 500, due_date: '2026-04-05' }]
    state.payments = [{ lease_id: 'lease_1', amount: 500, method: 'check', payment_date: '2026-04-10' }] // pays off the arrears, not this period

    const res = await postBilling()
    expect(res.status).toBe(200)

    expect(ledgerBalanceLease1()).toBe(5000) // arrears paid off, only this period's $5,000 rent remains
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500000 }), // full $5,000 this-period rent, not $5,500 or $0
      expect.anything(),
    )
  })

  // Round-3 review finding #4 (mutation M7): an in-period payment that is 'ach_stripe' but did
  // NOT succeed must not count as paid — only method+status together determine that, not method
  // alone. This fails if `counts` is mutated to ignore stripe_status.
  it('does not credit a failed in-period ACH payment against the current period', async () => {
    state.payments = [{ lease_id: 'lease_1', amount: 5000, method: 'ach_stripe', stripe_status: 'failed', payment_date: '2026-06-10' }]

    const res = await postBilling()
    expect(res.status).toBe(200)

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500000 }), // the failed payment must not reduce the debit at all
      expect.anything(),
    )
  })

  // A payment dated OUTSIDE the current period must not count as "this
  // period paid" even though it reduces the lifetime balance — otherwise a
  // payment for an old period would incorrectly suppress this period's debit.
  it('does not credit an out-of-period payment against the current period', async () => {
    state.payments = [{ lease_id: 'lease_1', amount: 5000, method: 'check', payment_date: '2026-05-15' }]

    const res = await postBilling()
    expect(res.status).toBe(200)

    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled() // lifetime balance is $0 → safety cap still applies
  })

  // Partial in-period payment: the gap must still be collected via autopay.
  it('debits the remaining period balance when the manual payment was in-period but partial', async () => {
    state.payments = [{ lease_id: 'lease_1', amount: 2000, method: 'check', payment_date: '2026-06-10' }]

    const res = await postBilling()
    expect(res.status).toBe(200)

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 300000 }), // $3,000 remaining on this period
      expect.anything(),
    )
  })

  // Edge: lease with no charges in the period → no $0 PaymentIntent
  it('does not create a PaymentIntent when the lease has no charges in the period', async () => {
    state.leases = [{ ...AUTOPAY_LEASE, base_rent_monthly: 0, cam_estimate_monthly: 0 }]

    const res = await postBilling()
    expect(res.status).toBe(200)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  // Stamping: the recorded payment carries the canonical period + actual amount
  it('records the payment with autopay_period = period start and the debited amount', async () => {
    state.payments = [{ lease_id: 'lease_1', amount: 2000, method: 'check' }]

    const res = await postBilling()
    expect(res.status).toBe(200)

    const autopayRows = state.payments.filter(p => p.method === 'ach_stripe')
    expect(autopayRows).toHaveLength(1)
    expect(autopayRows[0]).toMatchObject({
      lease_id: 'lease_1',
      amount: 3000,
      autopay_period: '2026-06-01',
      stripe_payment_intent_id: 'pi_auto_1',
    })
  })

  // -------------------------------------------------------------------------
  // OI-162/#1 regression coverage — round 1: bulk charge posting
  // -------------------------------------------------------------------------

  it('posts charges for a large portfolio in a SINGLE bulk upsert call, not one insert per charge', async () => {
    const N = 150 // comfortably over the ~49-lease point where the O(leases) code broke in production
    state.leases = Array.from({ length: N }, (_, i) => nonAutopayLease(`lease_${i}`, 4000 + i))

    const res = await postBilling()
    expect(res.status).toBe(200)
    const body = await res.json() as { posted: number; skipped: number; errors: number }

    expect(body.posted).toBe(N) // one rent charge per lease, all non-autopay so no CAM/eligibility noise
    expect(body.skipped).toBe(0)
    expect(body.errors).toBe(0)
    // The actual fix: exactly ONE upsert().select() round trip for the whole run, carrying all
    // N charges — not O(N) calls. A hoisted spy proves the call count, not just that the mock
    // object happens to have an 'upsert' key.
    expect(upsertChargesSpy).toHaveBeenCalledTimes(1)
    expect(state.charges).toHaveLength(N)
  })

  it('does not double-post charges on a second run for the same period (bulk idempotency)', async () => {
    state.leases = [nonAutopayLease('lease_a'), nonAutopayLease('lease_b')]

    const res1 = await postBilling()
    const body1 = await res1.json() as { posted: number; skipped: number }
    expect(body1.posted).toBe(2)
    expect(body1.skipped).toBe(0)

    const res2 = await postBilling()
    const body2 = await res2.json() as { posted: number; skipped: number; errors: number }
    expect(body2.posted).toBe(0)
    expect(body2.skipped).toBe(2)
    expect(body2.errors).toBe(0)
    expect(state.charges).toHaveLength(2) // still 2, not 4 — no duplicate rows
  })

  it('a bulk charge-upsert failure posts ZERO charges portfolio-wide and returns HTTP 500', async () => {
    state.leases = [nonAutopayLease('lease_a'), nonAutopayLease('lease_b')]
    state.chargesUpsertError = { message: 'connection reset' }

    const res = await postBilling()
    const body = await res.json() as { posted: number; chargeErrors: number; errors: number; errorMessages: string[] }

    // Review finding #2: a total charge-posting failure must not look like success.
    expect(res.status).toBe(500)
    expect(body.posted).toBe(0)
    expect(body.chargeErrors).toBe(2) // one per charge in the failed batch
    expect(body.errors).toBe(2)
    expect(body.errorMessages).toHaveLength(1) // ONE aggregated message, not one per lease
    expect(body.errorMessages[0]).toMatch(/bulk charge upsert failed/)
  })

  // Round-5 review finding #2: a charges-bulk-upsert failure must stop autopay processing
  // entirely, not run it against charges known NOT to have been posted. Before this fix, every
  // autopay-eligible lease would compute periodChargeTotal=0 (nothing in the DB), get counted
  // `skipped` ("nothing outstanding to collect") instead of deferred, and `remaining` would read
  // 0 ("nothing left to do") even though the whole portfolio still needs billing.
  it('defers autopay entirely (no DB calls, no Stripe calls) when the charge upsert fails', async () => {
    state.leases = [AUTOPAY_LEASE]
    state.chargesUpsertError = { message: 'connection reset' }

    const res = await postBilling()
    expect(res.status).toBe(500)
    const body = await res.json() as { skipped: number; remaining: number }

    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(inPaymentsSpy).not.toHaveBeenCalled()
    expect(inChargesSpy).not.toHaveBeenCalled()
    expect(inArLedgerSpy).not.toHaveBeenCalled()
    // The lease is still outstanding, not resolved as "nothing to collect."
    expect(body.skipped).toBe(0)
    expect(body.remaining).toBe(1)
  })

  // -------------------------------------------------------------------------
  // OI-162/#1 regression coverage — round 2 (post-review): bounded, bulk-fetched
  // autopay debit processing, closing the relocated-subrequest-wall finding.
  // -------------------------------------------------------------------------

  it('bulk-checks prior autopay collection for many eligible leases in a SINGLE query', async () => {
    const N = 6 // under AUTOPAY_BATCH_LIMIT so every eligible lease is actually processed
    state.leases = Array.from({ length: N }, (_, i) => autopayLease(`autopay_lease_${i}`))
    // Half already collected this period — must be skipped without a Stripe call.
    state.payments = state.leases.slice(0, 3).map(l => ({
      lease_id: (l as { id: string }).id,
      amount: 5000,
      method: 'ach_stripe',
      stripe_status: 'succeeded',
      autopay_period: '2026-06-01',
    }))

    const res = await postBilling()
    expect(res.status).toBe(200)
    const body = await res.json() as { skipped: number; errors: number }

    // Two bulk .in() calls on 'payments' this run — one for step 2's prior-period pre-check
    // (all 6 eligible leases), one for step 3's period-paid lookup (only the 3 not yet
    // collected) — both O(1) regardless of portfolio size, never one query per lease.
    expect(inPaymentsSpy).toHaveBeenCalledTimes(2)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(3) // only the not-yet-collected half
    expect(body.errors).toBe(0)
    expect(body.skipped).toBeGreaterThanOrEqual(3) // at least the 3 already-collected autopay skips
  })

  it('bulk-fetches open-charges, period-paid, and ar_ledger balance ONCE each for a batch of eligible leases', async () => {
    const N = 8
    state.leases = Array.from({ length: N }, (_, i) => autopayLease(`autopay_lease_${i}`))

    const res = await postBilling()
    expect(res.status).toBe(200)
    const body = await res.json() as { errors: number }
    expect(body.errors).toBe(0)

    // Step 3's three debit-input lookups are each ONE bulk .in() call, not one per lease.
    expect(inChargesSpy).toHaveBeenCalledTimes(1)
    expect(inArLedgerSpy).toHaveBeenCalledTimes(1)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(N)
  })

  it('bounds autopay debit processing to AUTOPAY_BATCH_LIMIT and reports the remainder', async () => {
    const N = 25 // over the batch limit (8)
    state.leases = Array.from({ length: N }, (_, i) => autopayLease(`autopay_lease_${i}`))

    const res = await postBilling()
    expect(res.status).toBe(200)
    const body = await res.json() as { remaining: number }

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(8) // AUTOPAY_BATCH_LIMIT (round 3: 10 -> 8)
    expect(body.remaining).toBe(N - 8)
  })

  // Round-4 review finding #1 (CRITICAL): reproduces the exact deadlock the review found —
  // AUTOPAY_BATCH_LIMIT (8) already-fully-paid (zero-debit) leases at the front of the eligible
  // list must NOT occupy the whole batch and starve leases that genuinely need a debit. Before
  // this fix, debit inputs were only bulk-fetched for the first AUTOPAY_BATCH_LIMIT not-yet-
  // collected leases, so a run of zero-debit leases there meant zero Stripe calls AND zero
  // progress on `remaining` every single invocation — the drain loop in trigger-billing.ps1 would
  // never converge. Fixed by resolving every not-yet-collected lease's debit amount first (a
  // bulk fetch over the FULL set, not just a batch), THEN applying the batch limit only to
  // leases that actually need a Stripe call.
  it('does not let a batch-limit\'s worth of already-paid leases starve leases that actually need a debit', async () => {
    const ZERO_DEBIT_COUNT = 8 // == AUTOPAY_BATCH_LIMIT
    const REAL_DEBIT_COUNT = 4
    // Ids prefixed so the zero-debit leases sort first: the handler pages leases ordered by id.
    const zeroDebitLeases = Array.from({ length: ZERO_DEBIT_COUNT }, (_, i) => autopayLease(`a_paid_${i}`))
    const realDebitLeases = Array.from({ length: REAL_DEBIT_COUNT }, (_, i) => autopayLease(`b_owes_${i}`))
    // Zero-debit leases come FIRST in eligibleLeases — the exact ordering that deadlocked round 3.
    state.leases = [...zeroDebitLeases, ...realDebitLeases]
    // Each zero-debit lease's rent is paid in full by check, in-period.
    state.payments = zeroDebitLeases.map(l => ({
      lease_id: (l as { id: string }).id,
      amount: 5000,
      method: 'check',
      payment_date: '2026-06-10',
    }))

    const res = await postBilling()
    expect(res.status).toBe(200)
    const body = await res.json() as { remaining: number; skipped: number }

    // All 4 real-debit leases get processed in this ONE invocation — not starved by the 8
    // zero-debit leases ahead of them in the list.
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(REAL_DEBIT_COUNT)
    for (const l of realDebitLeases) {
      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: (l as { tenants: { stripe_customer_id: string } }).tenants.stripe_customer_id }),
        expect.anything(),
      )
    }
    // Nothing left pending — the 8 zero-debit leases resolved (skipped) and all 4 real-debit
    // leases were processed, all within AUTOPAY_BATCH_LIMIT's Stripe-call budget.
    expect(body.remaining).toBe(0)
    expect(body.skipped).toBeGreaterThanOrEqual(ZERO_DEBIT_COUNT)
  })

  it('never debits blind: a failed bulk prior-autopay pre-check skips the ENTIRE autopay phase, returns HTTP 500, and reports the full batch as remaining', async () => {
    state.leases = [AUTOPAY_LEASE, { ...AUTOPAY_LEASE, id: 'lease_2', tenants: { id: 't2', stripe_customer_id: 'cus_2' } }]
    state.priorAutopayCheckError = { message: 'timeout' }

    const res = await postBilling()
    const body = await res.json() as { autopayErrors: number; errors: number; errorMessages: string[]; remaining: number }

    expect(res.status).toBe(500)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(body.autopayErrors).toBe(2) // one per eligible lease in the failed batch
    expect(body.errors).toBe(2)
    expect(body.errorMessages).toHaveLength(1) // ONE aggregated message
    expect(body.errorMessages[0]).toMatch(/autopay period pre-check failed/)
    // Round-3 review finding #1: a failed pre-check leaves BOTH eligible leases unprocessed —
    // `remaining` must say so, not silently read 0 (which would look like "nothing left to do").
    expect(body.remaining).toBe(2)
  })

  it('a failed bulk debit-input lookup returns HTTP 500 and adds the whole failed batch back into remaining', async () => {
    state.leases = [AUTOPAY_LEASE, { ...AUTOPAY_LEASE, id: 'lease_2', tenants: { id: 't2', stripe_customer_id: 'cus_2' } }]
    state.debitInputsError = { message: 'connection reset' }

    const res = await postBilling()
    // Round-3 review finding #7: this is the same class of whole-batch failure as the other two
    // (chargesBulkFailed, priorAutopayCheckFailed) — must not report 200 either.
    expect(res.status).toBe(500)
    const body = await res.json() as { autopayErrors: number; errorMessages: string[]; remaining: number }

    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(body.autopayErrors).toBe(2)
    expect(body.errorMessages.some(m => /autopay input lookup failed/.test(m))).toBe(true)
    // Round-3 review finding #1: the pre-check succeeded (both leases were "not yet collected"
    // and selected into toProcess), but the debit-input lookup for that batch then failed — the
    // whole toProcess batch must be added back into `remaining`, not silently dropped.
    expect(body.remaining).toBe(2)
  })

  it('chunks every bulk .in() query at 100 ids, never issuing one over that size', async () => {
    const N = 150 // over the 100-id chunk size (BULK_QUERY_CHUNK_SIZE)
    state.leases = Array.from({ length: N }, (_, i) => autopayLease(`autopay_lease_${i}`))

    const res = await postBilling()
    expect(res.status).toBe(200)

    // Round-4 review finding #3: the prior version of this test only checked that an 'eq' key
    // existed on the mock's return value, which is true for every .in() call regardless of
    // whether chunking actually happened (removing PRIOR_CHECK_CHUNK_SIZE entirely still passed
    // it). Assert on the ACTUAL argument lengths instead — this call spans both the prior-autopay
    // pre-check (step 2) and the debit-input period-paid lookup (step 3), both chunked via the
    // same fetchChunked helper, so every call's id-array length must be <= 100, and at least one
    // call must genuinely hit the 100-id ceiling (proving chunking happened, not that 150 ids
    // just happened to arrive under some other limit).
    const chunkSizes = inPaymentsSpy.mock.calls
      .filter(call => call[0] === 'lease_id')
      .map(call => (call[1] as string[]).length)
    expect(chunkSizes.length).toBeGreaterThan(0)
    expect(chunkSizes.every(len => len <= 100)).toBe(true)
    expect(chunkSizes).toContain(100)
  })

  it('does not call payments.in() (the prior-autopay bulk check) at all when there are zero autopay-eligible leases', async () => {
    state.leases = [nonAutopayLease('lease_a'), nonAutopayLease('lease_b')]

    const res = await postBilling()
    expect(res.status).toBe(200)

    expect(inPaymentsSpy).not.toHaveBeenCalled()
    expect(inChargesSpy).not.toHaveBeenCalled()
    expect(inArLedgerSpy).not.toHaveBeenCalled()
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('proves step 1\'s charge posting is what step 3 actually reads (same-run integration)', async () => {
    // A single autopay-eligible lease with NO charges seeded up front — step 1 must post its
    // $5,000 rent charge, and step 3's bulk open-charges query must see that SAME charge (not a
    // hand-set fixture) in order to compute the correct debit amount.
    state.leases = [AUTOPAY_LEASE]

    const res = await postBilling()
    expect(res.status).toBe(200)

    expect(state.charges).toHaveLength(1)
    expect(state.charges[0]).toMatchObject({ lease_id: 'lease_1', amount: 5000 })
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500000 }), // the exact charge step 1 just posted, read back by step 3
      expect.anything(),
    )
  })

  // -------------------------------------------------------------------------
  // PostgREST max_rows (1000) — silent truncation. Each test is built so the pre-fix handler
  // does the WRONG money thing against a capped response (bills too few leases, debits twice,
  // over-debits, under-collects), not merely so a length check trips.
  // -------------------------------------------------------------------------
  describe('PostgREST max_rows truncation', () => {
    type Body = { posted: number; remaining: number; autopayErrors: number; errorMessages: string[] }

    it('bills EVERY active lease when the portfolio exceeds one PostgREST page (leases select is paged, not truncated)', async () => {
      // Direction: a truncated leases select drops leases from the run entirely — no rent charge
      // posted and no autopay attempted for them, with a 200 and no error.
      const N = PG_MAX_ROWS + 1
      state.leases = Array.from({ length: N }, (_, i) => nonAutopayLease(`lease_${String(i).padStart(5, '0')}`))

      const res = await postBilling()
      expect(res.status).toBe(200)
      const body = await res.json() as Body

      expect(new Set(state.charges.map(c => c.lease_id)).size).toBe(N)
      expect(body.posted).toBe(N)
      // Keyset-paged, each page within the cap — not one oversized request.
      expect(leasesPageSpy).toHaveBeenCalledTimes(2)
      for (const [calls] of leasesPageSpy.mock.calls as [{ method: string; args: unknown[] }[]][]) {
        expect(calls.find(c => c.method === 'order')?.args[0]).toBe('id')
        const limit = calls.find(c => c.method === 'limit')
        expect(limit).toBeDefined()
        expect(limit!.args[0] as number).toBeLessThanOrEqual(PG_MAX_ROWS)
      }
    })

    it('fails closed (500, no Stripe call) when the prior-autopay pre-check chunk reaches the row cap — never re-debits a lease whose collection row was cut off', async () => {
      // Direction: WRONG charge. lease_2 was already autopay-collected this period, but its row
      // (still `processing`, as monthly-billing inserts it) sits past row 1000. Truncated, lease_2
      // looks uncollected; its processing payment counts toward neither period-paid nor the
      // ar_ledger balance, so the pre-fix handler debits it a second time.
      const lease1 = autopayLease('lease_1')
      const lease2 = autopayLease('lease_2')
      state.leases = [lease1, lease2]
      state.payments = [
        ...Array.from({ length: PG_MAX_ROWS }, () => ({ lease_id: 'lease_1', amount: 0, method: 'ach_stripe', stripe_status: 'failed', autopay_period: '2026-06-01', payment_date: '2026-05-01' })),
        { lease_id: 'lease_2', amount: 5000, method: 'ach_stripe', stripe_status: 'processing', autopay_period: '2026-06-01', payment_date: '2026-06-01' },
      ]

      const res = await postBilling()
      expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
      expect(res.status).toBe(500)
      const body = await res.json() as Body
      expect(body.remaining).toBe(2)
      expect(body.errorMessages.join(' ')).toMatch(/row cap/)
    })

    it('fails closed (500, no Stripe call) when a period-payments chunk reaches the row cap — never over-debits a tenant whose manual payment was cut off', async () => {
      // Direction: WRONG charge. lease_2 paid June by check (row 1001 of the chunk) but carries
      // May arrears, so its ar_ledger balance still covers a full debit. Truncated, the check
      // disappears, June looks unpaid, and the pre-fix handler debits lease_2 $5,000 for a period
      // it already paid — sweeping the arrears via an ACH the tenant never authorized for that.
      state.leases = [autopayLease('lease_1'), autopayLease('lease_2')]
      state.charges = [{ lease_id: 'lease_2', idempotency_key: 'arrears_lease_2_may', amount: 5000, due_date: '2026-05-01' }]
      state.payments = [
        ...Array.from({ length: PG_MAX_ROWS }, () => ({ lease_id: 'lease_1', amount: 1, method: 'ach_stripe', stripe_status: 'failed', payment_date: '2026-06-02' })),
        { lease_id: 'lease_2', amount: 5000, method: 'check', payment_date: '2026-06-03' },
      ]

      const res = await postBilling()
      expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
      expect(res.status).toBe(500)
      const body = await res.json() as Body
      expect(body.remaining).toBe(2)
      expect(body.errorMessages.join(' ')).toMatch(/period-payments/)
    })

    it('fails closed (500, lease left in remaining) when an open-charges chunk reaches the row cap — never under-collects from a truncated period total', async () => {
      // Direction: MISSED collection. 1000 $0 in-period charge rows precede this month's rent
      // charge; truncated, the rent charge vanishes, the period total reads $0, and the pre-fix
      // handler resolves lease_1 as "nothing to collect" (200, remaining 0).
      state.charges = Array.from({ length: PG_MAX_ROWS }, (_, i) => ({ lease_id: 'lease_1', idempotency_key: `zero_${i}`, amount: 0, due_date: '2026-06-15' }))

      const res = await postBilling()
      expect(res.status).toBe(500)
      const body = await res.json() as Body
      expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
      expect(body.remaining).toBe(1)
      expect(body.errorMessages.join(' ')).toMatch(/open-charges/)
    })

    it('fails closed (500, lease left in remaining) when an ar_ledger balance chunk reaches the row cap', async () => {
      // Direction: MISSED collection. A lease whose balance row is cut off reads balance 0, so
      // min(periodOutstanding, 0) = 0 and the pre-fix handler resolves it as "nothing to collect."
      state.arLedgerPaddingRows = PG_MAX_ROWS

      const res = await postBilling()
      expect(res.status).toBe(500)
      const body = await res.json() as Body
      expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
      expect(body.remaining).toBe(1)
      expect(body.errorMessages.join(' ')).toMatch(/ar_ledger/)
    })
  })
})
