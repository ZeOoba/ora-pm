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

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js — stateful, arg-aware mock.
//
// `state.payments` is a real in-memory payments table: the autopay pre-check
// (select ... eq lease_id, eq autopay_period) filters it by the ACTUAL query
// arguments, and payments.insert() appends to it. So invoking the handler
// twice genuinely reflects run 1's recorded payment in run 2 — the idempotency
// tests exercise real behavior, not a canned return value.
//
// `ar_ledger.balance` is computed the same way migration 0011's view does:
// total charged minus payments that count as paid (succeeded ACH, or
// check/wire/other). A just-created 'processing' ACH intent does NOT reduce
// the balance — mirroring the real settlement window in which only the
// autopay_period guard prevents a duplicate debit.
// ---------------------------------------------------------------------------
const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

type PaymentRow = {
  lease_id: string
  amount: number
  method: string
  stripe_status?: string
  autopay_period?: string
}

const state = {
  leases: [] as Record<string, unknown>[],
  periodCharges: [] as { amount: number }[],
  payments: [] as PaymentRow[],
  chargesInsertError: null as { code?: string; message: string } | null,
  paymentsInsertError: null as { code?: string; message: string } | null,
}

function ledgerBalance(): number {
  const totalCharged = state.periodCharges.reduce((s, ch) => s + ch.amount, 0)
  const totalPaid = state.payments.reduce((s, p) => {
    if (p.method === 'ach_stripe' && p.stripe_status === 'succeeded') return s + p.amount
    if (['check', 'wire', 'other'].includes(p.method)) return s + p.amount
    return s
  }, 0)
  return totalCharged - totalPaid
}

function installDbMock() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'leases') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: state.leases, error: null }),
        }),
      }
    }
    if (table === 'charges') {
      return {
        insert: vi.fn().mockImplementation(async () => ({ error: state.chargesInsertError })),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockResolvedValue({ data: state.periodCharges, error: null }),
            }),
          }),
        }),
      }
    }
    if (table === 'payments') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation((col1: string, val1: string) => ({
            eq: vi.fn().mockImplementation((col2: string, val2: string) => ({
              limit: vi.fn().mockImplementation(async () => ({
                data: state.payments.filter(p =>
                  col1 === 'lease_id' && p.lease_id === val1 &&
                  col2 === 'autopay_period' && p.autopay_period === val2
                ),
                error: null,
              })),
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
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => ({
              data: [{ balance: ledgerBalance() }],
              error: null,
            })),
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

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  RESEND_API_KEY: undefined,
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
  state.periodCharges = [{ amount: 5000 }]
  state.payments = []
  state.chargesInsertError = null
  state.paymentsInsertError = null
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

    // Run 2: run 1's payments row (autopay_period stamped) is now visible.
    // Charges from run 1 already exist → inserts collide.
    state.chargesInsertError = { code: '23505', message: 'duplicate key' }
    const res2 = await postBilling()
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { skipped: number; errors: number }

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(body2.errors).toBe(0)
    // charge insert skip + autopay skip
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
    expect(body.skipped).toBe(1) // the autopay skip (charge insert posted fresh)
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

  // Edge: lease with no charges in the period → no $0 PaymentIntent
  it('does not create a PaymentIntent when the lease has no charges in the period', async () => {
    state.leases = [{ ...AUTOPAY_LEASE, base_rent_monthly: 0, cam_estimate_monthly: 0 }]
    state.periodCharges = []

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
})
