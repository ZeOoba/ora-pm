import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
import { createApp } from '../../server/index'

// Auto-pass tenant auth middleware in tests
vi.mock('../../server/middleware/tenant-auth', () => ({
  tenantAuthMiddleware: vi.fn(async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('tenantUserId', 'user_test')
    await next()
  }),
}))

// Auto-pass the OI-045 AAL2 step-up gate in tests — this file exercises
// /autopay's OWN logic (ownership checks, Stripe verification, error
// hygiene), not the gate itself. The gate's behavior (including the actual
// PoC it closes) has its own dedicated coverage: tests/middleware/aal-guard.test.ts
// (unit) and tests/routes/portal-autopay-aal-integration.test.ts (proves the
// real gate is really wired onto the real route in the real app).
vi.mock('../../server/middleware/aal-guard', () => ({
  requireAal2: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const mockFrom = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mockFrom }),
}))

// Stripe mock for the autopay ownership-verification check (OI-043) — style
// follows tests/routes/stripe.test.ts's mockStripe/vi.mock('../../server/lib/stripe', ...) pattern.
const mockStripe = {
  paymentMethods: {
    retrieve: vi.fn(),
  },
}

vi.mock('../../server/lib/stripe', () => ({
  getStripe: vi.fn(() => mockStripe),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()

beforeEach(() => vi.clearAllMocks())

describe('GET /api/portal/me', () => {
  it('returns tenant profile and total balance', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'tenant_1', name: 'Test Co', contact_email: 'x@y.com', stripe_customer_id: 'cus_1', auth_user_id: 'user_test' },
              error: null,
            }),
          }),
        }),
      }
      if (table === 'ar_ledger') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [{ balance: 500 }, { balance: 250 }], error: null }),
        }),
      }
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) }
    })

    const res = await app.request('/api/portal/me', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { tenant: { id: string }; total_balance: number }
    expect(body.tenant.id).toBe('tenant_1')
    expect(body.total_balance).toBe(750)
  })
})

describe('GET /api/portal/charges', () => {
  // The charges chain the route builds: .select().in('lease_id', …).is('voided_at', null).order(…).
  // OI-278 / migration 0014: a tenant must never see (or be able to select for Pay Now) a voided
  // charge, so `.is('voided_at', null)` is part of the query and is asserted on below.
  function chargesTable(result: { data: unknown; error: unknown }) {
    const isSpy = vi.fn().mockReturnValue({ order: vi.fn().mockResolvedValue(result) })
    return {
      table: { select: vi.fn().mockReturnValue({ in: vi.fn().mockReturnValue({ is: isSpy }) }) },
      isSpy,
    }
  }

  it('returns charges for active leases, filtered to non-voided rows', async () => {
    const charges = chargesTable({ data: [{ id: 'charge_1', amount: 1200 }], error: null })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [{ id: 'lease_1' }], error: null }),
          }),
        }),
      }
      if (table === 'charges') return charges.table
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/charges', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string }[] }
    expect(body.data).toHaveLength(1)
    expect(charges.isSpy).toHaveBeenCalledWith('voided_at', null)
  })

  // RED 5 (OI-042 portal slice, site portal.ts:50) — the charges query failure
  // must never echo the raw Postgres error (schema/constraint names) to a
  // tenant-reachable response.
  it('returns a generic error, not the raw Postgres message, when the charges query fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [{ id: 'lease_1' }], error: null }),
          }),
        }),
      }
      if (table === 'charges') return chargesTable({
        data: null,
        error: { message: 'relation "charges" violates row-level security policy tenant_own_charges', code: '42501' },
      }).table
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/charges', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/tenant_own_charges|relation|42501/i)
  })

  it('returns empty array when tenant has no active leases', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/charges', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data).toHaveLength(0)
  })
})

// RED 5 (OI-042 portal slice, site portal.ts:74) — same error-hygiene
// requirement as GET /charges above.
describe('GET /api/portal/payments', () => {
  it('returns a generic error, not the raw Postgres message, when the payments query fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [{ id: 'lease_1' }], error: null }),
        }),
      }
      if (table === 'payments') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'relation "payments" violates row-level security policy tenant_own_payments', code: '42501' },
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/payments', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/tenant_own_payments|relation|42501/i)
  })
})

// RED 5 (OI-042 portal slice, site portal.ts:93) — same error-hygiene
// requirement as GET /charges above.
describe('GET /api/portal/lease', () => {
  it('returns a generic error, not the raw Postgres message, when the lease query fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'relation "leases" violates row-level security policy tenant_own_leases', code: '42501' },
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/lease', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/tenant_own_leases|relation|42501/i)
  })
})

// RED 5 (OI-042 portal slice, site portal.ts:117) — same error-hygiene
// requirement as GET /charges above.
describe('GET /api/portal/documents', () => {
  it('returns a generic error, not the raw Postgres message, when the documents query fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [{ id: 'lease_1' }], error: null }),
        }),
      }
      if (table === 'lease_documents') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'relation "lease_documents" violates row-level security policy tenant_own_documents', code: '42501' },
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/documents', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/tenant_own_documents|relation|42501/i)
  })
})

describe('PATCH /api/portal/autopay', () => {
  // Stands up the tenants/leases mocks shared by the autopay tests below.
  // `updateSpy` lets a test assert exactly what (if anything) was persisted
  // to `leases.autopay_payment_method_id`; `updateError` exercises the
  // OI-042 dbError path at portal.ts:141.
  function mockAutopayTables(opts: {
    tenant?: { id: string; stripe_customer_id?: string | null } | null
    lease?: { id: string; tenant_id: string } | null
    updateSpy?: ReturnType<typeof vi.fn>
    updateError?: { message: string; code?: string } | null
  } = {}) {
    const {
      tenant = { id: 'tenant_1', stripe_customer_id: 'cus_1' },
      lease = { id: 'lease_1', tenant_id: 'tenant_1' },
      updateSpy,
      updateError = null,
    } = opts
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: tenant, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: lease, error: null }),
          }),
        }),
        update: updateSpy ?? vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: updateError }),
        }),
      }
      return { select: vi.fn() }
    })
  }

  it('enables autopay with payment method (RED 4 — regression: valid PM owned by tenant, right type, stored as before)', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    mockAutopayTables({ updateSpy: updateMock })
    mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_bank', customer: 'cus_1', type: 'us_bank_account' })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: 'pm_bank' }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { autopay_enabled: boolean }
    expect(body.autopay_enabled).toBe(true)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ autopay_payment_method_id: 'pm_bank' }))
  })

  it('returns 404 when lease belongs to a different tenant (IDOR guard — unchanged by this task)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              // lease belongs to a DIFFERENT tenant
              data: { id: 'lease_other', tenant_id: 'tenant_other' },
              error: null,
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_other', enabled: true }),
    }, env)
    expect(res.status).toBe(404)
  })

  // ---------------------------------------------------------------------
  // OI-043 — autopay payment-method ownership verification
  // ---------------------------------------------------------------------

  it('RED 1: 403 when the payment method belongs to a different Stripe customer, and never persists it', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    mockAutopayTables({ updateSpy: updateMock })
    mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_other', customer: 'cus_OTHER', type: 'us_bank_account' })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: 'pm_other' }),
    }, env)
    expect(res.status).toBe(403)
    expect(updateMock).not.toHaveBeenCalled()
  })

  // REFUTE-pass coverage gap (2026-08-03): the ownership check is `pm.customer
  // !== tenant.stripe_customer_id` — correctly rejects an orphaned PM (never
  // attached to any Stripe customer, customer: null) since null !== a real
  // customer id, but that path was previously unpinned by any test. A future
  // refactor of that boolean could silently reintroduce a bypass with nothing
  // to catch it.
  it('403 when the payment method has no attached Stripe customer at all (orphaned PM)', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    mockAutopayTables({ updateSpy: updateMock })
    mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_orphan', customer: null, type: 'us_bank_account' })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: 'pm_orphan' }),
    }, env)
    expect(res.status).toBe(403)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('RED 2: 400 on a malformed payment_method_id, before any Stripe call', async () => {
    mockAutopayTables()

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: "'; DROP TABLE payments; --" }),
    }, env)
    expect(res.status).toBe(400)
    expect(mockStripe.paymentMethods.retrieve).not.toHaveBeenCalled()
  })

  it('RED 3: 403 when Stripe reports the payment method as a card, not a bank account', async () => {
    mockAutopayTables()
    mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_card1', customer: 'cus_1', type: 'card' })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: 'pm_card1' }),
    }, env)
    expect(res.status).toBe(403)
  })

  it('returns 400 when the tenant has no Stripe customer on file, before any Stripe call', async () => {
    mockAutopayTables({ tenant: { id: 'tenant_1', stripe_customer_id: null } })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: 'pm_bank123' }),
    }, env)
    expect(res.status).toBe(400)
    expect(mockStripe.paymentMethods.retrieve).not.toHaveBeenCalled()
  })

  it('maps a Stripe "no such payment_method" error to 400', async () => {
    mockAutopayTables()
    mockStripe.paymentMethods.retrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ message: 'No such PaymentMethod: pm_ghost' })
    )

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: 'pm_ghost' }),
    }, env)
    expect(res.status).toBe(400)
  })

  // RED 5 (OI-042 portal slice, site portal.ts:141) — same error-hygiene
  // requirement as the GET routes above. enabled:false skips the Stripe
  // ownership check entirely (payment_method_id is cleared, not verified),
  // isolating this test to the leases.update failure path.
  it('RED 5: returns a generic error, not the raw Postgres message, when the autopay update fails', async () => {
    mockAutopayTables({ updateError: { message: 'relation "leases" violates row-level security policy tenant_own_leases', code: '42501' } })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: false }),
    }, env)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).not.toMatch(/tenant_own_leases|relation|42501/i)
  })
})
