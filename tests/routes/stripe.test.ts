import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
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
  // OI-233: the post-Stripe write-back (UPDATE payments ... WHERE
  // client_request_id = ?) can be made to fail independently of the insert.
  paymentsUpdateError: null as { message: string; code?: string } | null,
  // Simulates the reserve_payment_intent() RPC itself failing (transport /
  // function error) — distinct from a balance-read failure inside it.
  reserveRpcError: null as { message: string; code?: string } | null,
  leaseSelectResult: { data: null as Record<string, unknown> | null, error: null as { message: string } | null },
  // ar_ledger.balance is in US dollars (matches the live view — see
  // ar-ledger.test.ts / cron.ts's autopay debit cap). Default is comfortably
  // above every existing test's amount_cents so the new balance-cap check
  // (OI-040) doesn't over-block tests that predate it; individual RED cases
  // override this to exercise the cap itself. Since OI-065/223 the balance is
  // read INSIDE reserve_payment_intent() (under the per-lease lock), so the
  // RPC stand-in below reads this same value.
  arLedgerResult: { data: [{ balance: 999_999 }] as Array<{ balance: number }> | null, error: null as { message: string } | null },
}

// ---------------------------------------------------------------------------
// In-memory `payments` table + a stand-in for the reserve_payment_intent()
// Postgres function (supabase/migrations/0014_payment_intent_pending_row.sql).
//
// The real function runs the whole reserve step — per-lease advisory lock →
// same-client_request_id lookup → ar_ledger balance → in-flight
// (pending/processing) subtraction → pending-row insert — inside ONE
// transaction, so concurrent callers for the same lease are serialized and
// each sees the previous caller's reservation. This stand-in models that
// contract by mutating `paymentsTable` synchronously (no await between read
// and write), which is what lets the Promise.all concurrency cases below
// prove the ROUTE's behavior on top of that contract. The function's own
// structure (lock-before-read, statuses, grants) is pinned by
// tests/db/payment-intent-migration-0014.test.ts.
// ---------------------------------------------------------------------------
type PaymentRow = {
  id: string
  lease_id: string
  payment_date: string
  amount: number
  method: string
  stripe_payment_intent_id: string | null
  stripe_status: string | null
  notes: string | null
  client_request_id: string | null
  created_at: number
}
let paymentsTable: PaymentRow[] = []
let paymentSeq = 0

function reservePaymentIntentStandIn(args: {
  p_lease_id: string
  p_client_request_id: string
  p_amount_cents: number
  p_notes: string | null
}) {
  const existing = paymentsTable.find((r) => r.client_request_id === args.p_client_request_id)
  if (existing) {
    return {
      outcome: 'existing',
      payment_id: existing.id,
      stripe_payment_intent_id: existing.stripe_payment_intent_id,
      stripe_status: existing.stripe_status,
      amount_cents: Math.round(existing.amount * 100),
      age_seconds: Math.floor((Date.now() - existing.created_at) / 1000),
    }
  }
  if (supabaseMocks.arLedgerResult.error) throw supabaseMocks.arLedgerResult.error
  const balanceCents = Math.round((supabaseMocks.arLedgerResult.data?.[0]?.balance ?? 0) * 100)
  const inFlightCents = Math.round(
    paymentsTable
      .filter((r) => r.lease_id === args.p_lease_id && r.method === 'ach_stripe' && (r.stripe_status === 'pending' || r.stripe_status === 'processing'))
      .reduce((s, r) => s + r.amount, 0) * 100,
  )
  const availableCents = balanceCents - inFlightCents
  const figures = { outstanding_balance_cents: balanceCents, in_flight_cents: inFlightCents, available_cents: availableCents }
  if (balanceCents <= 0) return { outcome: 'no_balance', ...figures }
  if (args.p_amount_cents > availableCents) return { outcome: 'exceeds_balance', ...figures }
  const row: PaymentRow = {
    id: `pay-${++paymentSeq}`,
    lease_id: args.p_lease_id,
    payment_date: new Date().toISOString().slice(0, 10),
    amount: args.p_amount_cents / 100,
    method: 'ach_stripe',
    stripe_payment_intent_id: null,
    stripe_status: 'pending',
    notes: args.p_notes,
    client_request_id: args.p_client_request_id,
    created_at: Date.now(),
  }
  paymentsTable.push(row)
  return { outcome: 'reserved', payment_id: row.id, ...figures }
}

function paymentsTableMock() {
  return {
    insert: vi.fn().mockImplementation(async (row: Partial<PaymentRow> & Pick<PaymentRow, 'lease_id' | 'payment_date' | 'amount' | 'method'>) => {
      if (supabaseMocks.paymentsInsertError) return { data: null, error: supabaseMocks.paymentsInsertError }
      const defaults: Omit<PaymentRow, 'lease_id' | 'payment_date' | 'amount' | 'method'> = {
        id: `pay-${++paymentSeq}`,
        stripe_payment_intent_id: null,
        stripe_status: null,
        notes: null,
        client_request_id: null,
        created_at: Date.now(),
      }
      paymentsTable.push({ ...defaults, ...row })
      return { data: null, error: null }
    }),
    update: vi.fn().mockImplementation((patch: Partial<PaymentRow>) => {
      const filters: Array<(r: PaymentRow) => boolean> = []
      const builder = {
        eq: vi.fn().mockImplementation((col: keyof PaymentRow, val: unknown) => { filters.push((r) => r[col] === val); return builder }),
        in: vi.fn().mockImplementation((col: keyof PaymentRow, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return builder }),
        is: vi.fn().mockImplementation((col: keyof PaymentRow, val: unknown) => { filters.push((r) => r[col] === val); return builder }),
        select: vi.fn().mockImplementation(async () => {
          if (supabaseMocks.paymentsUpdateError) return { data: null, error: supabaseMocks.paymentsUpdateError }
          const matched = paymentsTable.filter((r) => filters.every((f) => f(r)))
          for (const r of matched) Object.assign(r, patch)
          return { data: matched.map((r) => ({ id: r.id })), error: null }
        }),
      }
      return builder
    }),
  }
}

const mockDb = {
  rpc: vi.fn(async (fn: string, args: Parameters<typeof reservePaymentIntentStandIn>[0]) => {
    if (fn !== 'reserve_payment_intent') return { data: null, error: { message: `unknown rpc ${fn}` } }
    if (supabaseMocks.reserveRpcError) return { data: null, error: supabaseMocks.reserveRpcError }
    try {
      return { data: reservePaymentIntentStandIn(args), error: null }
    } catch (e) {
      return { data: null, error: e as { message: string } }
    }
  }),
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
      return paymentsTableMock()
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
  paymentsTable = []
  paymentSeq = 0
  supabaseMocks.tenantSelectResult = { data: null, error: null }
  supabaseMocks.tenantUpdateError = null
  supabaseMocks.paymentsInsertError = null
  supabaseMocks.paymentsUpdateError = null
  supabaseMocks.reserveRpcError = null
  // Default: the authenticated tenant (tenant-1) owns lease-1
  supabaseMocks.leaseSelectResult = { data: { id: 'lease-1', tenant_id: 'tenant-1' }, error: null }
  supabaseMocks.arLedgerResult = { data: [{ balance: 999_999 }], error: null }
})

// Seeds a row the way cron.ts's autopay path or a prior payment-intent
// request would leave it (PI id known, status per Stripe).
function seedPayment(row: Partial<PaymentRow> & { amount: number }) {
  paymentsTable.push({
    id: `seed-${++paymentSeq}`,
    lease_id: 'lease-1',
    payment_date: '2026-09-01',
    method: 'ach_stripe',
    stripe_payment_intent_id: null,
    stripe_status: null,
    notes: null,
    client_request_id: null,
    created_at: Date.now(),
    ...row,
  })
}

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
    // The reservation goes through reserve_payment_intent() BEFORE Stripe is
    // called, and the PI id/status is written back onto that same row after.
    expect(mockDb.rpc).toHaveBeenCalledWith('reserve_payment_intent', expect.objectContaining({
      p_lease_id: 'lease-1',
      p_client_request_id: validPayload.client_request_id,
      p_amount_cents: 250000,
    }))
    expect(mockDb.rpc.mock.invocationCallOrder[0]).toBeLessThan(mockStripe.paymentIntents.create.mock.invocationCallOrder[0])
    expect(mockDb.from).toHaveBeenCalledWith('payments')
    expect(paymentsTable).toHaveLength(1)
    expect(paymentsTable[0]).toMatchObject({
      lease_id: 'lease-1',
      amount: 2500,
      method: 'ach_stripe',
      client_request_id: validPayload.client_request_id,
      stripe_payment_intent_id: 'pi_test456',
      stripe_status: 'processing',
    })
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

  // Review follow-up (OI-065/223/233): description now reaches reserve_payment_intent() — a real
  // DB write to payments.notes — BEFORE Stripe's own 1000-char cap would have rejected an oversized
  // value. Must be rejected here, before any write, not discovered downstream as a Stripe error on
  // an already-'pending' row.
  it('10. returns 400 when description exceeds 500 characters, before reserving anything', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }

    const res = await post('/api/stripe/payment-intent', { ...validPayload, description: 'x'.repeat(501) })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/description/i)
    expect(mockDb.rpc).not.toHaveBeenCalled()
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('11. accepts a description at exactly the 500-character boundary', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_boundary', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, description: 'x'.repeat(500) })
    expect(res.status).toBe(200)
  })

  it('12. accepts a request with no description at all', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_no_desc', status: 'processing' })

    const { description: _omit, ...payloadNoDescription } = validPayload
    const res = await post('/api/stripe/payment-intent', payloadNoDescription)
    expect(res.status).toBe(200)
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

  it('11. returns 500 (and never calls Stripe) when the reservation RPC itself fails', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.reserveRpcError = { message: 'function reserve_payment_intent does not exist', code: '42883' }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_never', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', validPayload)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/reserve/i)
    expect(body.error).not.toMatch(/does not exist/) // no DB detail to the client
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(paymentsTable).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // OI-035 route half — idempotent retries via client_request_id
  // -------------------------------------------------------------------------
  it('RED1. a retry with the same client_request_id after a recorded payment is deduped WITHOUT a second Stripe call', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_dedupe_1', status: 'processing' })
    const payload = { ...validPayload, client_request_id: '11111111-1111-4111-8111-111111111111' }

    const res1 = await post('/api/stripe/payment-intent', payload)
    expect(res1.status).toBe(200)

    // Client retry, same client_request_id — reserve_payment_intent() finds
    // the existing row (already carrying pi_dedupe_1) and the route returns
    // it directly. Previously this path re-called Stripe and relied on the
    // idempotency cache + a 23505 on payments_stripe_pi_uniq to dedupe.
    const res2 = await post('/api/stripe/payment-intent', payload)
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { payment_intent_id: string; status: string; deduped?: boolean }
    expect(body2.deduped).toBe(true)
    expect(body2.payment_intent_id).toBe('pi_dedupe_1')
    expect(body2.status).toBe('processing')
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(paymentsTable).toHaveLength(1)
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
    expect(paymentsTable).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // OI-065 — concurrency: two requests for the same lease can no longer both
  // read the same stale balance and both create a PaymentIntent.
  // -------------------------------------------------------------------------
  it('OI-065a. a concurrent double-submit with the SAME client_request_id yields exactly one Stripe call and one pending row', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_once', status: 'processing' })
    const payload = { ...validPayload, client_request_id: '33333333-3333-4333-8333-333333333333' }

    // Both in flight at once — neither has written a PI id back yet when the
    // second reaches reserve_payment_intent().
    const [resA, resB] = await Promise.all([
      post('/api/stripe/payment-intent', payload),
      post('/api/stripe/payment-intent', payload),
    ])
    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = resA.status === 409 ? resA : resB
    const loserBody = await loser.json() as { error: string; in_progress?: boolean }
    expect(loserBody.error).toMatch(/in progress/i)
    expect(loserBody.in_progress).toBe(true)

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(paymentsTable).toHaveLength(1)
    expect(paymentsTable[0].stripe_payment_intent_id).toBe('pi_once')
  })

  it('OI-065b. two concurrent requests with DIFFERENT client_request_ids for the same lease are serialized — the second is refused once the first reservation consumes the balance', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null } // $2,500 owed
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_first', status: 'processing' })
    const tabA = { ...validPayload, amount_cents: 250000, client_request_id: '44444444-4444-4444-8444-444444444444' }
    const tabB = { ...validPayload, amount_cents: 250000, client_request_id: '55555555-5555-4555-8555-555555555555' }

    // Before the fix: both read balance=$2,500, both pass the cap, both create
    // a separate PaymentIntent with distinct idempotency keys → $5,000 debited
    // against a $2,500 balance. payments_stripe_pi_uniq cannot catch it (the
    // PI ids genuinely differ).
    const [resA, resB] = await Promise.all([
      post('/api/stripe/payment-intent', tabA),
      post('/api/stripe/payment-intent', tabB),
    ])
    expect([resA.status, resB.status].sort()).toEqual([200, 422])
    const refused = resA.status === 422 ? resA : resB
    const refusedBody = await refused.json() as { error: string }
    expect(refusedBody.error).toMatch(/exceeds outstanding balance/i)

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(paymentsTable).toHaveLength(1)
    expect(paymentsTable[0].amount).toBe(2500)
  })

  it('OI-065c. two concurrent DIFFERENT requests that the balance CAN cover both succeed (serialization must not over-block)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 5000 }], error: null } // $5,000 owed
    mockStripe.paymentIntents.create
      .mockResolvedValueOnce({ id: 'pi_a', status: 'processing' })
      .mockResolvedValueOnce({ id: 'pi_b', status: 'processing' })
    const tabA = { ...validPayload, amount_cents: 250000, client_request_id: '66666666-6666-4666-8666-666666666666' }
    const tabB = { ...validPayload, amount_cents: 250000, client_request_id: '77777777-7777-4777-8777-777777777777' }

    const [resA, resB] = await Promise.all([
      post('/api/stripe/payment-intent', tabA),
      post('/api/stripe/payment-intent', tabB),
    ])
    expect([resA.status, resB.status]).toEqual([200, 200])
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(2)
    expect(paymentsTable.map((r) => r.stripe_payment_intent_id).sort()).toEqual(['pi_a', 'pi_b'])
  })

  // -------------------------------------------------------------------------
  // OI-223 — pending/processing ACH is invisible to ar_ledger.balance (the
  // view only credits 'succeeded'); the cap must subtract it.
  // -------------------------------------------------------------------------
  it('OI-223a. a processing ACH payment on the lease reduces the amount a second payment may be for (422 when it would double-pay)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null } // $2,500 owed per ar_ledger
    // Payment #1 for the full $2,500 is still in the ACH settlement window —
    // ar_ledger still shows the FULL $2,500 owed.
    seedPayment({ amount: 2500, stripe_payment_intent_id: 'pi_in_flight', stripe_status: 'processing', client_request_id: '88888888-8888-4888-8888-888888888888' })
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_should_not_exist', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: '99999999-9999-4999-8999-999999999999' })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/exceeds outstanding balance/i)
    expect(body.error).toMatch(/processing/i) // tells the tenant WHY — a payment is already in flight
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
    expect(paymentsTable).toHaveLength(1) // no reservation was written
  })

  it('OI-223b. a partial in-flight payment leaves exactly the remainder payable (boundary — must not over-block)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null }
    seedPayment({ amount: 1000, stripe_payment_intent_id: 'pi_partial', stripe_status: 'processing' })
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_remainder', status: 'processing' })

    const tooMuch = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 150001, client_request_id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' })
    expect(tooMuch.status).toBe(422)

    const exact = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 150000, client_request_id: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1' })
    expect(exact.status).toBe(200)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
  })

  it('OI-223c. a pending reservation with no PI yet (a crashed earlier attempt) also counts against the balance', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null }
    seedPayment({ amount: 2500, stripe_payment_intent_id: null, stripe_status: 'pending', client_request_id: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1' })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1' })
    expect(res.status).toBe(422)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('OI-223d. succeeded / failed / returned rows do NOT count as in-flight (ar_ledger already handles succeeded; failed never moved money)', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null }
    seedPayment({ amount: 2500, stripe_payment_intent_id: 'pi_ok', stripe_status: 'succeeded' })
    seedPayment({ amount: 2500, stripe_payment_intent_id: 'pi_bad', stripe_status: 'failed' })
    seedPayment({ amount: 2500, stripe_payment_intent_id: 'pi_ret', stripe_status: 'returned' })
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_new', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1' })
    expect(res.status).toBe(200)
  })

  // -------------------------------------------------------------------------
  // OI-233 — Stripe has confirmed the debit; the ledger write must never be
  // able to lose it.
  // -------------------------------------------------------------------------
  it('OI-233a. when the post-Stripe write-back fails, the pending row (amount, lease, client_request_id) still exists and the response still carries the PI id', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.paymentsUpdateError = { message: 'connection reset by peer', code: '08006' }
    supabaseMocks.paymentsInsertError = { message: 'connection reset by peer', code: '08006' }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_money_moved', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', validPayload)
    // Money moved. The client must learn the PI id (so it does not re-submit
    // as a NEW payment), and must not be told the payment failed.
    expect(res.status).toBe(200)
    const body = await res.json() as { payment_intent_id: string; status: string; recorded?: boolean }
    expect(body.payment_intent_id).toBe('pi_money_moved')
    expect(body.recorded).toBe(false)

    // The trace Stripe's dashboard can be reconciled against: a 'pending' row
    // with the right lease/amount, keyed by client_request_id, PI id NULL.
    expect(paymentsTable).toHaveLength(1)
    expect(paymentsTable[0]).toMatchObject({
      lease_id: 'lease-1',
      amount: 2500,
      method: 'ach_stripe',
      client_request_id: validPayload.client_request_id,
      stripe_status: 'pending',
      stripe_payment_intent_id: null,
    })
  })

  it('OI-233b. the PaymentIntent carries client_request_id in its metadata so the webhook can find the row when the PI id was never written back', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_meta', status: 'processing' })

    await post('/api/stripe/payment-intent', validPayload)

    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ lease_id: 'lease-1', tenant_id: 'tenant-1', client_request_id: validPayload.client_request_id }),
      }),
      expect.anything(),
    )
  })

  it('OI-233c. a definitive pre-debit Stripe rejection (invalid_request) releases the reservation so it stops counting against the balance', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null }
    mockStripe.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'No such payment_method: pm_test_bank' } as never),
    )

    const res1 = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1' })
    expect(res1.status).toBe(400)
    expect(paymentsTable).toHaveLength(1)
    expect(paymentsTable[0].stripe_status).toBe('failed') // no money moved — released

    // A fresh attempt for the full balance is not blocked by the dead reservation.
    mockStripe.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_retry_ok', status: 'processing' })
    const res2 = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2' })
    expect(res2.status).toBe(200)
  })

  it('OI-233d. an INDETERMINATE Stripe failure (connection error) leaves the reservation pending — money may have moved', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null }
    mockStripe.paymentIntents.create.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: 'socket hang up' } as never),
    )

    const res1 = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2' })
    expect(res1.status).toBe(502)
    expect(paymentsTable).toHaveLength(1)
    expect(paymentsTable[0].stripe_status).toBe('pending') // NOT released: Stripe may have created the PI

    // ...so a DIFFERENT request for the same balance is refused until it is
    // resolved (by the webhook fallback, the same-id resume below, or a human).
    const res2 = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3' })
    expect(res2.status).toBe(422)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1)
  })

  it('OI-233e. a same-client_request_id retry after the in-flight window RESUMES the reservation: Stripe is re-called with the SAME idempotency key and the PI is written back', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    supabaseMocks.arLedgerResult = { data: [{ balance: 2500 }], error: null }
    const crid = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'
    // A reservation from an attempt that died before write-back, 5 minutes ago.
    seedPayment({ amount: 2500, stripe_payment_intent_id: null, stripe_status: 'pending', client_request_id: crid, created_at: Date.now() - 5 * 60_000 })
    // Stripe's idempotency cache returns the ORIGINAL PI for the same key —
    // whether or not the first attempt's call ever reached Stripe, at most
    // one PI exists for this key.
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_resumed', status: 'processing' })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: crid })
    expect(res.status).toBe(200)
    const body = await res.json() as { payment_intent_id: string; resumed?: boolean }
    expect(body.payment_intent_id).toBe('pi_resumed')
    expect(body.resumed).toBe(true)
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: `pi:tenant-1:${crid}` }),
    )
    expect(paymentsTable).toHaveLength(1) // resumed onto the SAME row, no second reservation
    expect(paymentsTable[0]).toMatchObject({ stripe_payment_intent_id: 'pi_resumed', stripe_status: 'processing' })
  })

  it('OI-233f. a same-client_request_id retry inside the in-flight window is refused (409) without calling Stripe', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    const crid = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'
    seedPayment({ amount: 2500, stripe_payment_intent_id: null, stripe_status: 'pending', client_request_id: crid, created_at: Date.now() - 10_000 })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: crid })
    expect(res.status).toBe(409)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('OI-233g. a same-client_request_id retry OLDER than Stripe\'s idempotency window is refused (409) without calling Stripe — a fresh key could mint a second PI', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    const crid = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2'
    seedPayment({ amount: 2500, stripe_payment_intent_id: null, stripe_status: 'pending', client_request_id: crid, created_at: Date.now() - 25 * 3600_000 })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 250000, client_request_id: crid })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/reconcil/i)
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('OI-233h. a same-client_request_id retry with a DIFFERENT amount is refused (409) before Stripe — the key is bound to the original amount', async () => {
    supabaseMocks.tenantSelectResult = { data: { id: 'tenant-1', stripe_customer_id: 'cus_test123' }, error: null }
    const crid = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2'
    seedPayment({ amount: 2500, stripe_payment_intent_id: null, stripe_status: 'pending', client_request_id: crid, created_at: Date.now() - 5 * 60_000 })

    const res = await post('/api/stripe/payment-intent', { ...validPayload, amount_cents: 100000, client_request_id: crid })
    expect(res.status).toBe(409)
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
    expect(mockDb.rpc).not.toHaveBeenCalled()
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
    expect(mockDb.rpc).not.toHaveBeenCalled()
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
