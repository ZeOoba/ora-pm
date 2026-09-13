// tests/routes/stripe-aal-integration.test.ts
//
// OI-045 — end-to-end proof that the REAL requireAal2 middleware is really
// wired onto POST /api/stripe/setup-intent and POST /api/stripe/payment-intent
// in the REAL app. A REFUTE pass on the original /autopay-only fix found
// both of these ungated: /setup-intent is what actually attaches a
// us_bank_account PaymentMethod to a tenant's Stripe customer, and
// /payment-intent CONFIRMS a charge immediately (confirm:true) — the single
// most sensitive write path in this router, since it moves real money.
// A stolen aal1 bearer JWT (session hijack, no MFA device) previously had
// no server-side barrier to either action.
//
// Deliberately does NOT mock tenant-auth or aal-guard (unlike
// tests/routes/stripe.test.ts, which auto-passes both to test the routes'
// OWN logic in isolation) — only the lowest-level @supabase/supabase-js
// client and the Stripe SDK are mocked, so both real middlewares run for
// real against them.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockGetUser = vi.hoisted(() => vi.fn())
const mockGetAal = vi.hoisted(() => vi.fn())
const mockFrom = vi.hoisted(() => vi.fn())

// OI-065/223/233: /payment-intent now reserves its ledger row through the
// reserve_payment_intent() RPC before calling Stripe — stub it as a plain
// successful reservation so the happy path can still reach Stripe.
const mockRpc = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser, mfa: { getAuthenticatorAssuranceLevel: mockGetAal } },
    from: mockFrom,
    rpc: mockRpc,
  }),
}))

const mockStripe = {
  setupIntents: { create: vi.fn() },
  paymentIntents: { create: vi.fn() },
}
vi.mock('../../server/lib/stripe', () => ({ getStripe: vi.fn(() => mockStripe) }))
vi.mock('../../server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()

function post(path: string, jwt: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

// Happy-path DB mock — armed so that if the AAL gate were NOT actually
// enforced, these requests would sail through. Its presence is what makes
// the 403 assertions below mean something.
function armDbHappyPath() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'tenants') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1', stripe_customer_id: 'cus_1' }, error: null }),
          }),
        }),
      }
    }
    if (table === 'leases') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'lease_1', tenant_id: 'tenant_1' }, error: null }),
          }),
        }),
      }
    }
    if (table === 'ar_ledger') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [{ balance: 500 }], error: null }),
          }),
        }),
      }
    }
    if (table === 'payments') {
      const written = { data: [{ id: 'pay_1' }], error: null }
      return {
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue(written) }),
            eq: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue(written) }),
          }),
        }),
      }
    }
    return { select: vi.fn() }
  })
  mockRpc.mockResolvedValue({
    data: { outcome: 'reserved', payment_id: 'pay_1', outstanding_balance_cents: 50000, in_flight_cents: 0, available_cents: 50000 },
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user_test' } }, error: null })
  armDbHappyPath()
  mockStripe.setupIntents.create.mockResolvedValue({ client_secret: 'seti_secret' })
  mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_1', status: 'succeeded' })
})

const AAL1_NO_STEPUP = { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] }
const AAL2_STEPPED_UP = { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] }

describe('POST /api/stripe/setup-intent — real requireAal2 wired onto the real route', () => {
  it('THE BYPASS THE REFUTE PASS FOUND: a stolen aal1 JWT cannot attach a bank account, no browser involved', async () => {
    mockGetAal.mockResolvedValue({ data: AAL1_NO_STEPUP, error: null })
    const res = await post('/api/stripe/setup-intent', 'stolen_aal1_jwt', { tenant_id: 'tenant_1' })
    expect(res.status).toBe(403)
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled()
  })

  it('a genuine aal2 session succeeds end-to-end', async () => {
    mockGetAal.mockResolvedValue({ data: AAL2_STEPPED_UP, error: null })
    const res = await post('/api/stripe/setup-intent', 'valid_aal2_jwt', { tenant_id: 'tenant_1' })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/stripe/payment-intent — real requireAal2 wired onto the real route', () => {
  const VALID_BODY = {
    tenant_id: 'tenant_1',
    lease_id: 'lease_1',
    amount_cents: 10000,
    payment_method_id: 'pm_attacker_attached',
    client_request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }

  it('THE MOST SEVERE BYPASS: a stolen aal1 JWT cannot confirm a real ACH charge, no browser involved', async () => {
    mockGetAal.mockResolvedValue({ data: AAL1_NO_STEPUP, error: null })
    const res = await post('/api/stripe/payment-intent', 'stolen_aal1_jwt', VALID_BODY)
    expect(res.status).toBe(403)
    // The one assertion that matters most here: no money moved.
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('a genuine aal2 session can still complete a real payment end-to-end', async () => {
    mockGetAal.mockResolvedValue({ data: AAL2_STEPPED_UP, error: null })
    const res = await post('/api/stripe/payment-intent', 'valid_aal2_jwt', VALID_BODY)
    expect(res.status).toBe(200)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
  })

  it('OI-081: a tenant with no verified MFA factor at all is now BLOCKED, not waved through', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
      error: null,
    })
    const res = await post('/api/stripe/payment-intent', 'valid_no_mfa_jwt', VALID_BODY)
    expect(res.status).toBe(403)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })
})
