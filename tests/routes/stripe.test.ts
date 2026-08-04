import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'
import { tenantAuthMiddleware } from '../../server/middleware/tenant-auth'
import { checkRateLimit } from '../../server/lib/rate-limit'

// ---------------------------------------------------------------------------
// Mock auth middleware — authenticate as a fixed user in tests.
// 'auth-user-A' resolves (via the tenants mock below) to tenant 'tenant-1'.
// ---------------------------------------------------------------------------
vi.mock('../../server/middleware/tenant-auth', () => ({
  tenantAuthMiddleware: vi.fn(
    async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('tenantUserId', 'auth-user-A')
      await next()
    }
  ),
}))

vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

// OI-045: auto-pass the AAL2 step-up gate here — this file exercises
// setup-intent/payment-intent's OWN logic (IDOR guards, amount caps,
// idempotency), not the gate itself. The gate's behavior (including the
// actual bypass it closes) has its own dedicated coverage:
// tests/middleware/aal-guard.test.ts and
// tests/routes/portal-autopay-aal-integration.test.ts.
vi.mock('../../server/middleware/aal-guard', () => ({
  requireAal2: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

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

// checkRateLimit is now async and KV-backed (OI-038 remainder, Task 6) —
// mocked here the same as before, just returning a resolved Promise so the
// route's `await checkRateLimit(...)` call site works under test.
vi.mock('../../server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}))

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js — chainable query builder
// ---------------------------------------------------------------------------
// We keep a mutable map so individual tests can override return values.
const supabaseMocks = {
  tenantSelectResult: { data: null as Record<string, unknown> | null, error: null as { message: string } | null },
  tenantUpdateError: null as { message: string } | null,
  paymentsInsertError: null as { message: string; code?: string } | null,
  leaseSelectResult: { data: null as Record<string, unknown> | null, error: null as { message: string } | null },
  // ar_ledger.balance is in US dollars (matches the live view — see
  // ar-ledger.test.ts / cron.ts's autopay debit cap). Default is comfortably
  // above every existing test's amount_cents so the new balance-cap check
  // (OI-040) doesn't over-block tests that predate it; individual RED cases
  // override this to exercise the cap itself.
  arLedgerResult: { data: [{ balance: 999_999 }] as Array<{ balance: number }> | null, error: null as { message: string } | null },
}

const mockDb = {
  from: vi.fn((table: string) => {
    if (table === 'tenants') {
      return {
        // Arg-aware: the tenant row resolves ONLY when queried by the
        // authenticated user's auth_user_id. A regression back to resolving by
        // the request-body tenant_id (.eq('id', ...)) — the original OI-018
        // vulnerability — gets { data: null } and fails these tests.
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation((column: string, value: string) => ({
            single: vi.fn().mockImplementation(async () =>
              column === 'auth_user_id' && value === 'auth-user-A'
                ? supabaseMocks.tenantSelectResult
                : { data: null, error: { message: 'not found' } }
            ),
          })),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation(async () => ({
            data: null,
            error: supabaseMocks.tenantUpdateError,
          })),
        }),
      }
    }
    if (table === 'leases') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockImplementation(async () => supabaseMocks.leaseSelectResult),
          }),
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
    if (table === 'ar_ledger') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => supabaseMocks.arLedgerResult),
          }),
        }),
      }
    }
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }
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
  // Default: the authenticated tenant (tenant-1) owns lease-1
  supabaseMocks.leaseSelectResult = { data: { id: 'lease-1', tenant_id: 'tenant-1' }, error: null }
  supabaseMocks.arLedgerResult = { data: [{ balance: 999_999 }], error: null }
})

// ---------------------------------------------------------------------------
// POST /api/stripe/customer
// ---------------------------------------------------------------------------
describe('POST /api/stripe/customer', () => {
  it('1. creates a Stripe customer and returns customer_id (200)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: null }, error: null }
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
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_existing' }, error: null }

    const res = await post('/api/stripe/customer', { tenant_id: 'tenant-1' })
    expect(res.status).toBe(200)
    const body = await res.json() as { customer_id: string }
    expect(body.customer_id).toBe('cus_existing')
    expect(mockStripe.customers.create).not.toHaveBeenCalled()
  })

  it('3b. returns 404 when tenant not found in DB', async () => {
    supabaseMocks.tenantSelectResult = { data: null, error: { message: 'not found' } }

    const res = await post('/api/stripe/customer', { tenant_id: 'missing-tenant' })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/tenant/i)
  })

  it('3c. returns 500 when DB update fails (ghost customer prevention)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: null }, error: null }
    supabaseMocks.tenantUpdateError = { message: 'DB write failed' }
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_ghost' })

    const res = await post('/api/stripe/customer', { tenant_id: 'tenant-1', email: 'x@example.com' })
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/save/i)
  })
})

// ---------------------------------------------------------------------------
// POST /api/stripe/setup-intent
// ---------------------------------------------------------------------------
describe('POST /api/stripe/setup-intent', () => {
  it('4. creates SetupIntent and returns client_secret (200)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.setupIntents.create.mockResolvedValue({ client_secret: 'seti_test_secret' })

    const res = await post('/api/stripe/setup-intent', { tenant_id: 'tenant-1' })
    expect(res.status).toBe(200)
    const body = await res.json() as { client_secret: string }
    expect(body.client_secret).toBe('seti_test_secret')
    expect(mockStripe.setupIntents.create).toHaveBeenCalledOnce()
  })

  it('5. returns 400 when tenant has no Stripe customer', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: null }, error: null }

    const res = await post('/api/stripe/setup-intent', { tenant_id: 'tenant-1' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/customer/i)
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled()
  })

  it('5b. returns 404 when tenant not found in DB', async () => {
    supabaseMocks.tenantSelectResult = { data: null, error: { message: 'not found' } }

    const res = await post('/api/stripe/setup-intent', { tenant_id: 'missing-tenant' })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/tenant/i)
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
    client_request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }

  it('6. creates PaymentIntent, records payment, returns id + status (200)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
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
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }

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

  it('9. returns 400 when amount_cents is not an integer', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250.50 })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/integer/i)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('10. returns 404 when tenant not found in DB', async () => {
    supabaseMocks.tenantSelectResult = { data: null, error: { message: 'not found' } }

    const res = await post('/api/stripe/payment-intent', validPayload)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/tenant/i)
  })

  it('11a. returns 404 when lease not found', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.leaseSelectResult = { data: null, error: { message: 'not found' } }

    const res = await post('/api/stripe/payment-intent', validPayload)
    expect(res.status).toBe(404)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('11. returns 500 when payments DB insert fails', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.paymentsInsertError = { message: 'insert failed' }
    mockStripe.paymentIntents.create.mockResolvedValue({
      id: 'pi_test789',
      status: 'processing',
    })

    const res = await post('/api/stripe/payment-intent', validPayload)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/record/i)
  })

  // -------------------------------------------------------------------------
  // OI-035 route half — idempotent retries via client_request_id
  // -------------------------------------------------------------------------
  it('RED1. a duplicate client_request_id whose payments insert collides (23505) is a successful dedupe, not a 500', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_dedupe_1', status: 'processing' })
    const payload = { ...validPayload, client_request_id: '11111111-1111-4111-8111-111111111111' }

    const res1 = await post('/api/stripe/payment-intent', payload)
    expect(res1.status).toBe(200)

    // Client retry, same client_request_id — Stripe's idempotency cache returns
    // the same PI, and the payments insert now collides on the unique
    // stripe_payment_intent_id (payments_stripe_pi_uniq, Task 1).
    supabaseMocks.paymentsInsertError = { code: '23505', message: 'duplicate key value violates unique constraint "payments_stripe_pi_uniq"' }
    const res2 = await post('/api/stripe/payment-intent', payload)
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { payment_intent_id: string; status: string; deduped?: boolean }
    expect(body2.deduped).toBe(true)
    expect(body2.payment_intent_id).toBe('pi_dedupe_1')
  })

  it('RED2. passes idempotencyKey pi:<tenantId>:<client_request_id> to paymentIntents.create', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_key_check', status: 'processing' })
    const payload = { ...validPayload, client_request_id: '22222222-2222-4222-8222-222222222222' }

    await post('/api/stripe/payment-intent', payload)

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: payload.amount_cents }),
      expect.objectContaining({ idempotencyKey: 'pi:tenant-1:22222222-2222-4222-8222-222222222222' }),
    )
  })

  // -------------------------------------------------------------------------
  // OI-040 — amount caps + ar_ledger reconciliation
  // -------------------------------------------------------------------------
  it('RED3. returns 422 when amount_cents exceeds the $50,000 hard cap', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 10_000_000 })
    expect(res.status).toBe(422)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('RED4. returns 422 "Amount exceeds outstanding balance" when amount_cents exceeds the ar_ledger balance', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 500 }], error: null } // $500 = 50,000 cents

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 60000 })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/exceeds outstanding balance/i)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('RED5. returns 422 "No balance due" when the ar_ledger balance is $0, regardless of requested amount', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 0 }], error: null }

    const res = await post('/api/stripe/payment-intent', validPayload)
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/no balance due/i)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('RED6. allows amount_cents exactly equal to the outstanding balance (boundary — must not over-block)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 500 }], error: null } // $500 = 50,000 cents
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_boundary', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 50000 })
    expect(res.status).toBe(200)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledOnce()
  })

  it('BONUS. returns 500 (never a blind allow) when the ar_ledger query itself fails', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: null, error: { message: 'connection reset' } }

    const res = await post('/api/stripe/payment-intent', validPayload)
    expect(res.status).toBe(500)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('BONUS. rejects a malformed (non-UUID) client_request_id before ever calling Stripe', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }

    const res = await post('/api/stripe/payment-intent', { ...validPayload, client_request_id: 'not-a-uuid' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/uuid/i)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // OI-038, IP-handling slice — CF-Connecting-IP over spoofable X-Forwarded-For
  // -------------------------------------------------------------------------
  it('RED7. rate-limits by the tenant user id when only X-Forwarded-For is present (no CF-Connecting-IP)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_ip_check', status: 'processing' })

    const app = createApp()
    await app.request('/api/stripe/payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
      body: JSON.stringify(validPayload),
    }, ENV as unknown as Record<string, string>)

    // 'auth-user-A' is the tenantUserId the mocked tenantAuthMiddleware sets —
    // the spoofable X-Forwarded-For value ('203.0.113.7') must never reach the
    // rate limiter as the key. (checkRateLimit's signature is now
    // (kv, key, config) — Task 6; ENV has no RATE_LIMIT_KV, so kv is undefined.)
    expect(checkRateLimit).toHaveBeenCalledWith(
      undefined,
      'auth-user-A',
      expect.objectContaining({ scope: 'payment-intent', maxCalls: 5, windowMs: 60_000 }),
    )
  })
})

// ---------------------------------------------------------------------------
// IDOR guard (OI-018) — request-body tenant_id / lease_id must belong to the
// authenticated user. The mocked tenantAuthMiddleware authenticates as
// 'auth-user-A', whose tenant row (via .eq('auth_user_id', ...)) is 'tenant-1'.
// A request naming any OTHER tenant's ids must be rejected BEFORE any Stripe
// call or DB write.
// ---------------------------------------------------------------------------
describe('IDOR guard (OI-018)', () => {
  it('I1. POST /customer rejects a tenant_id belonging to another tenant (403)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: null }, error: null }
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_should_never_exist' })

    const res = await post('/api/stripe/customer', {
      tenant_id: 'tenant-B',
      email: 'attacker@example.com',
      name: 'Tenant A',
    })
    expect(res.status).toBe(403)
    expect(mockStripe.customers.create).not.toHaveBeenCalled()
  })

  it('I2. POST /setup-intent rejects a tenant_id belonging to another tenant (403)', async () => {
    // tenant-B's record has a Stripe customer — the leaked client_secret would
    // let tenant A attach a bank account to tenant B's customer.
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_own' }, error: null }
    mockStripe.setupIntents.create.mockResolvedValue({ client_secret: 'seti_leaked_secret' })

    const res = await post('/api/stripe/setup-intent', { tenant_id: 'tenant-B' })
    expect(res.status).toBe(403)
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled()
  })

  it('I3. POST /payment-intent rejects a tenant_id belonging to another tenant (403)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_own' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_leak', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', {
      tenant_id: 'tenant-B',
      lease_id: 'lease-1',
      amount_cents: 250000,
      payment_method_id: 'pm_test_bank',
      client_request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    expect(res.status).toBe(403)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(mockDb.from).not.toHaveBeenCalledWith('payments')
  })

  it('I4. POST /payment-intent rejects a lease_id belonging to another tenant (404)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_own' }, error: null }
    supabaseMocks.leaseSelectResult = { data: { id: 'lease-B', tenant_id: 'tenant-B' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_leak', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', {
      tenant_id: 'tenant-1',
      lease_id: 'lease-B',
      amount_cents: 250000,
      payment_method_id: 'pm_test_bank',
      client_request_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
    expect(res.status).toBe(404)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(mockDb.from).not.toHaveBeenCalledWith('payments')
  })

  it('I6. all 3 stripe endpoints are wired through tenantAuthMiddleware', async () => {
    // /api/stripe is ADMIN_EXEMPT, so this middleware is its ONLY auth layer.
    // If the router-wide use('/*', tenantAuthMiddleware) were removed, these
    // requests would reach the handlers without it ever being invoked.
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_own' }, error: null }
    mockStripe.setupIntents.create.mockResolvedValue({ client_secret: 'seti_x' })
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_x', status: 'processing' })

    await post('/api/stripe/customer', { tenant_id: 'tenant-1' })
    await post('/api/stripe/setup-intent', { tenant_id: 'tenant-1' })
    await post('/api/stripe/payment-intent', {
      tenant_id: 'tenant-1',
      lease_id: 'lease-1',
      amount_cents: 250000,
      payment_method_id: 'pm_test_bank',
      client_request_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })
    expect(tenantAuthMiddleware).toHaveBeenCalledTimes(3)
  })

  it('I5. positive path — own tenant_id + own lease_id still succeeds (200)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_own' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_own', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', {
      tenant_id: 'tenant-1',
      lease_id: 'lease-1',
      amount_cents: 250000,
      payment_method_id: 'pm_test_bank',
      client_request_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { payment_intent_id: string }
    expect(body.payment_intent_id).toBe('pi_own')
  })
})
