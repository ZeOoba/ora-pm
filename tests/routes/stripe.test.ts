import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

// ---------------------------------------------------------------------------
// Mock server/lib/stripe — return a controllable stub
// ---------------------------------------------------------------------------
const mockStripe = {
  customers: {
    create: vi.fn(),
  },
  setupIntents: {
    create: vi.fn(),
  },
  paymentIntents: {
    create: vi.fn(),
  },
}

vi.mock('../../server/lib/stripe', () => ({
  getStripe: vi.fn(() => mockStripe),
}))

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js — chainable query builder
// ---------------------------------------------------------------------------
// We keep a mutable map so individual tests can override return values.
const supabaseMocks = {
  tenantSelectResult: { data: null as Record<string, unknown> | null, error: null },
  tenantUpdateError: null as { message: string } | null,
  paymentsInsertError: null as { message: string } | null,
}

// Build a chainable mock that captures the method chain and resolves at .single()
function makeChain(resolveWith: () => { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const noop = () => chain
  chain.select = noop
  chain.eq = noop
  chain.update = noop
  chain.insert = () => ({ select: () => ({ single: resolveWith }), then: resolveWith })
  chain.single = resolveWith
  return chain
}

const mockDb = {
  from: vi.fn((table: string) => {
    if (table === 'tenants') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockImplementation(async () => supabaseMocks.tenantSelectResult),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation(async () => ({
            data: null,
            error: supabaseMocks.tenantUpdateError,
          })),
        }),
      }
    }
    if (table === 'payments') {
      return {
        insert: vi.fn().mockImplementation(async () => ({
          data: null,
          error: supabaseMocks.paymentsInsertError,
        })),
      }
    }
    return makeChain(() => Promise.resolve({ data: null, error: null }))
  }),
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockDb),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  CRON_SECRET: 'test-cron',
}

async function post(path: string, body: unknown) {
  const app = createApp()
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, ENV as unknown as Record<string, string>)
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  supabaseMocks.tenantSelectResult = { data: null, error: null }
  supabaseMocks.tenantUpdateError = null
  supabaseMocks.paymentsInsertError = null
})

// ---------------------------------------------------------------------------
// POST /api/stripe/customer
// ---------------------------------------------------------------------------
describe('POST /api/stripe/customer', () => {
  it('1. creates a Stripe customer and returns customer_id (200)', async () => {
    supabaseMocks.tenantSelectResult = { data: { stripe_customer_id: null }, error: null }
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_test123' })

    const res = await post('/api/stripe/customer', {
      tenant_id: 'tenant-1',
      email: 'test@example.com',
      name: 'Test Tenant',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { customer_id: string }
    expect(body.customer_id).toBe('cus_test123')
    expect(mockStripe.customers.create).toHaveBeenCalledOnce()
  })

  it('2. returns 400 when tenant_id is missing', async () => {
    const res = await post('/api/stripe/customer', { email: 'x@example.com' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/tenant_id/)
  })

  it('3. returns existing stripe_customer_id without calling Stripe', async () => {
    supabaseMocks.tenantSelectResult = { data: { stripe_customer_id: 'cus_existing' }, error: null }

    const res = await post('/api/stripe/customer', { tenant_id: 'tenant-1' })
    expect(res.status).toBe(200)
    const body = await res.json() as { customer_id: string }
    expect(body.customer_id).toBe('cus_existing')
    expect(mockStripe.customers.create).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/stripe/setup-intent
// ---------------------------------------------------------------------------
describe('POST /api/stripe/setup-intent', () => {
  it('4. creates SetupIntent and returns client_secret (200)', async () => {
    supabaseMocks.tenantSelectResult = { data: { stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.setupIntents.create.mockResolvedValue({ client_secret: 'seti_test_secret' })

    const res = await post('/api/stripe/setup-intent', { tenant_id: 'tenant-1' })
    expect(res.status).toBe(200)
    const body = await res.json() as { client_secret: string }
    expect(body.client_secret).toBe('seti_test_secret')
    expect(mockStripe.setupIntents.create).toHaveBeenCalledOnce()
  })

  it('5. returns 400 when tenant has no Stripe customer', async () => {
    supabaseMocks.tenantSelectResult = { data: { stripe_customer_id: null }, error: null }

    const res = await post('/api/stripe/setup-intent', { tenant_id: 'tenant-1' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/customer/i)
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/stripe/payment-intent
// ---------------------------------------------------------------------------
describe('POST /api/stripe/payment-intent', () => {
  const validPayload = {
    tenant_id: 'tenant-1',
    lease_id: 'lease-1',
    amount_cents: 250000,
    payment_method_id: 'pm_test_bank',
    description: 'June 2026 rent',
  }

  it('6. creates PaymentIntent, records payment, returns id + status (200)', async () => {
    supabaseMocks.tenantSelectResult = { data: { stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({
      id: 'pi_test456',
      status: 'processing',
    })

    const res = await post('/api/stripe/payment-intent', validPayload)
    expect(res.status).toBe(200)
    const body = await res.json() as { payment_intent_id: string; status: string }
    expect(body.payment_intent_id).toBe('pi_test456')
    expect(body.status).toBe('processing')
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledOnce()
    // Verify the DB insert was called for payments table
    expect(mockDb.from).toHaveBeenCalledWith('payments')
  })

  it('7. returns 400 when amount_cents < 50', async () => {
    supabaseMocks.tenantSelectResult = { data: { stripe_customer_id: 'cus_test123' }, error: null }

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 49 })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/minimum/i)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('8. returns 400 when required fields are missing', async () => {
    const { payment_method_id: _omit, ...incomplete } = validPayload

    const res = await post('/api/stripe/payment-intent', incomplete)
    expect(res.status).toBe(400)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })
})
