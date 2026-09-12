// OI-234 (ruled 2026-09-12, "Oldest-first"): a late fee is owed only when a charge 30+ days past
// due is actually UNPAID. Payments apply to the oldest charges first (standard AR aging), so:
//
//   recent_i  = Σ charges.amount for lease i with due_date > cutoff (today − GRACE_DAYS)
//   overdue_i = ar_ledger.balance_i − recent_i
//   delinquent iff overdue_i > 0.005 (half-cent epsilon for float money)
//
// Pre-fix the endpoint fined any positive-balance lease that had ANY charge dated ≤ cutoff, even
// one that was fully paid — a tenant current on every old invoice and owing only this month's
// (not-yet-overdue) rent got a $50 fee. These tests pin the ruled arithmetic, the digest
// membership (only overdue_i > 0 leases), the unchanged response shape, the unchanged
// idempotency guards, chunked querying, and fail-closed on query error.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

// /api/cron/* is throttled 10/hour per path via a module-scope in-memory window (no RATE_LIMIT_KV
// in tests) — mocked to always allow, same pattern as tests/routes/cron-billing.test.ts, so this
// file's many sequential requests don't trip it and read as a 429.
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
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})

type ARRow = { lease_id: string; tenant_id: string; tenant_name: string; property_name: string | null; suite: string | null; balance: number }
type RecentRow = { lease_id: string; amount: number | string }
type Resp = { late_fees_posted: number; delinquent_count: number; email: { subject: string; body: string } | null; error?: string }

const ar = (lease_id: string, balance: number, tenant_name = `Tenant ${lease_id}`): ARRow =>
  ({ lease_id, tenant_id: `t_${lease_id}`, tenant_name, property_name: 'Prop', suite: lease_id, balance })

// Shape-aware `charges` stub. Unlike cron-alerts.test.ts's order-based `chainable`, this routes on
// the PREDICATE the handler builds, so the tests assert the ruled query (`due_date > cutoff`,
// selecting `amount`) rather than a call order:
//   - a chain containing .gt('due_date', …)                  -> the recent-charges query
//   - a chain containing .eq('type','late_fee')              -> the existing-fee guard
//   - anything else (e.g. the pre-fix .lte('due_date', …))   -> resolves as a query ERROR, so the
//     pre-fix implementation fails these tests with a 500, not by accident of mock ordering.
type Call = { method: string; args: unknown[] }
type ChargesStub = {
  recent: RecentRow[] | { error: string }
  existingFees?: { lease_id: string }[]
  insert?: ReturnType<typeof vi.fn>
}
function makeCharges(stub: ChargesStub) {
  const selects: { cols: string; calls: Call[] }[] = []
  const insert = stub.insert ?? vi.fn().mockResolvedValue({ error: null })
  const table = {
    insert,
    selects,
    select(cols: string) {
      const calls: Call[] = []
      selects.push({ cols, calls })
      const b: Record<string, unknown> = {}
      for (const m of ['in', 'gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'limit', 'order']) {
        b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b }
      }
      b.then = (resolve: (v: unknown) => void) => {
        const isRecent = calls.some(c => c.method === 'gt' && c.args[0] === 'due_date')
        const isFeeGuard = calls.some(c => c.method === 'eq' && c.args[0] === 'type' && c.args[1] === 'late_fee')
        if (isRecent) {
          if ('error' in stub.recent && !Array.isArray(stub.recent)) return resolve({ data: null, error: { message: stub.recent.error } })
          const chunk = (calls.find(c => c.method === 'in')?.args[1] as string[] | undefined) ?? []
          return resolve({ data: (stub.recent as RecentRow[]).filter(r => chunk.includes(r.lease_id)), error: null })
        }
        if (isFeeGuard) {
          const chunk = (calls.find(c => c.method === 'in')?.args[1] as string[] | undefined) ?? []
          return resolve({ data: (stub.existingFees ?? []).filter(r => chunk.includes(r.lease_id)), error: null })
        }
        return resolve({ data: null, error: { message: `unexpected charges query shape: ${JSON.stringify(calls)}` } })
      }
      return b
    },
  }
  return table
}

function wire(arRows: ARRow[], charges: ReturnType<typeof makeCharges>) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'ar_ledger') return {
      select: vi.fn().mockReturnValue({ gt: vi.fn().mockResolvedValue({ data: arRows, error: null }) }),
    }
    if (table === 'charges') return charges
    return { select: vi.fn() }
  })
}

async function run(): Promise<{ status: number; body: Resp }> {
  const res = await app.request('/api/cron/delinquency-check', { method: 'POST', headers: { Authorization: 'Bearer test' } }, env)
  return { status: res.status, body: await res.json() as Resp }
}

const today = new Date().toISOString().slice(0, 10)
const [yyyy, mm] = today.split('-')

describe('POST /api/cron/delinquency-check — oldest-first overdue test (OI-234)', () => {
  it('(a) paid old charge + unpaid current charge -> no fee, not in digest', async () => {
    // Old rent 1200 (paid) + this month's 1200 (unpaid, not yet 30 days past due): balance 1200,
    // recent 1200, overdue 0.
    const charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 1200 }] })
    wire([ar('lease_1', 1200)], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body).toEqual({ late_fees_posted: 0, delinquent_count: 0, email: null })
    expect(charges.insert).not.toHaveBeenCalled()
  })

  it('(b) unpaid old charge -> $50 fee posted with the unchanged idempotency key, listed in digest', async () => {
    const charges = makeCharges({ recent: [] })
    wire([ar('lease_1', 1200, 'Acme')], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.late_fees_posted).toBe(1)
    expect(body.delinquent_count).toBe(1)
    expect(body.email).not.toBeNull()
    expect(body.email!.subject).toContain('1 Delinquent Tenant')
    expect(body.email!.body).toContain('Acme')
    expect(body.email!.body).toContain('Balance: $1250.00')
    expect(charges.insert).toHaveBeenCalledTimes(1)
    expect(charges.insert).toHaveBeenCalledWith(expect.objectContaining({
      lease_id: 'lease_1', type: 'late_fee', amount: 50, source: 'auto',
      charge_date: today, due_date: today,
      idempotency_key: `late_fee_lease_1_${yyyy}_${mm}`,
    }))
    // The recent-charges query must fetch the amount it sums (not a bare lease_id existence probe).
    const recentSelect = charges.selects.find(s => s.calls.some(c => c.method === 'gt' && c.args[0] === 'due_date'))
    expect(recentSelect).toBeDefined()
    expect(recentSelect!.cols).toMatch(/\blease_id\b/)
    expect(recentSelect!.cols).toMatch(/\bamount\b/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('(c) partial payment leaving part of an old charge unpaid -> fee', async () => {
    // Old 1200 + recent 1200 charged, 1000 paid: balance 1400, recent 1200, overdue 200.
    const charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 1200 }] })
    wire([ar('lease_1', 1400)], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.late_fees_posted).toBe(1)
    expect(body.delinquent_count).toBe(1)
    expect(charges.insert).toHaveBeenCalledTimes(1)
  })

  it('(d) partial payment covering all old charges but not the recent one -> no fee, not listed', async () => {
    // Old 1200 + recent 1200 charged, 1300 paid: balance 1100, recent 1200, overdue -100.
    const charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 1200 }] })
    wire([ar('lease_1', 1100)], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body).toEqual({ late_fees_posted: 0, delinquent_count: 0, email: null })
    expect(charges.insert).not.toHaveBeenCalled()
  })

  it('(e) existing fee this month -> no second fee, still listed while overdue', async () => {
    // Old 1200 unpaid + this month's $50 fee: balance 1250, recent 50 (the fee), overdue 1200.
    const charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 50 }], existingFees: [{ lease_id: 'lease_1' }] })
    wire([ar('lease_1', 1250, 'Acme')], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.late_fees_posted).toBe(0)
    expect(body.delinquent_count).toBe(1)
    expect(body.email!.body).toContain('Balance: $1250.00')
    expect(charges.insert).not.toHaveBeenCalled()
  })

  it('(e2) a late fee posted this month never makes itself overdue', async () => {
    // Tenant paid the old rent after the fee posted; only the $50 fee (due_date = its post date,
    // i.e. "recent") remains: balance 50, recent 50, overdue 0 -> not listed, no fee.
    const charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 50 }], existingFees: [{ lease_id: 'lease_1' }] })
    wire([ar('lease_1', 50)], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body).toEqual({ late_fees_posted: 0, delinquent_count: 0, email: null })
    expect(charges.insert).not.toHaveBeenCalled()
  })

  it('(f) overdue within the half-cent epsilon -> no fee (0.004 and float noise), one cent -> fee', async () => {
    // 0.004 over: below epsilon.
    let charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 1000 }] })
    wire([ar('lease_1', 1000.004)], charges)
    let out = await run()
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ late_fees_posted: 0, delinquent_count: 0, email: null })
    expect(charges.insert).not.toHaveBeenCalled()

    // Float noise: 0.1 + 0.2 = 0.30000000000000004 vs a recent charge of 0.30.
    charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 0.3 }] })
    wire([ar('lease_1', 0.1 + 0.2)], charges)
    out = await run()
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ late_fees_posted: 0, delinquent_count: 0, email: null })
    expect(charges.insert).not.toHaveBeenCalled()

    // One real cent of old money outstanding is delinquent.
    charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: 1000 }] })
    wire([ar('lease_1', 1000.01)], charges)
    out = await run()
    expect(out.status).toBe(200)
    expect(out.body.late_fees_posted).toBe(1)
    expect(out.body.delinquent_count).toBe(1)
    expect(charges.insert).toHaveBeenCalledTimes(1)
  })

  it('(g) recent-charges query error -> 500, nothing posted, no digest', async () => {
    const charges = makeCharges({ recent: { error: 'recent boom' } })
    wire([ar('lease_1', 1200)], charges)
    const { status, body } = await run()
    expect(status).toBe(500)
    expect(body.error).toContain('recent boom')
    expect(body.email).toBeUndefined()
    expect(body.late_fees_posted).toBeUndefined()
    expect(charges.insert).not.toHaveBeenCalled()
  })

  it('(h) digest lists only overdue leases across a mixed portfolio; counts stay numeric', async () => {
    const charges = makeCharges({
      recent: [
        { lease_id: 'current', amount: 1200 },   // balance 1200, recent 1200 -> current
        { lease_id: 'overdue', amount: 1200 },   // balance 2400, recent 1200 -> 1200 overdue
        { lease_id: 'credit', amount: 1200 },    // balance 400, recent 1200 -> overpaid old, only recent open
      ],
    })
    wire([ar('current', 1200, 'Current Co'), ar('overdue', 2400, 'Overdue LLC'), ar('credit', 400, 'Credit Inc'), ar('nothing_recent', 800, 'Stale Corp')], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.late_fees_posted).toBe(2)
    expect(body.delinquent_count).toBe(2)
    expect(body.email!.subject).toContain('2 Delinquent Tenants')
    expect(body.email!.body).toContain('Overdue LLC')
    expect(body.email!.body).toContain('Stale Corp')
    expect(body.email!.body).not.toContain('Current Co')
    expect(body.email!.body).not.toContain('Credit Inc')
    expect(Object.keys(body).sort()).toEqual(['delinquent_count', 'email', 'late_fees_posted'])
  })

  it('(i) sums amounts arriving as strings (NUMERIC serialized as text) numerically, not by concatenation', async () => {
    const charges = makeCharges({ recent: [{ lease_id: 'lease_1', amount: '700.00' }, { lease_id: 'lease_1', amount: '500.00' }] })
    wire([ar('lease_1', 1200)], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body).toEqual({ late_fees_posted: 0, delinquent_count: 0, email: null })
  })

  it('(j) 23505 idempotency collision on insert -> no fee counted, lease still listed', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } })
    const charges = makeCharges({ recent: [], insert })
    wire([ar('lease_1', 1200, 'Acme')], charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.late_fees_posted).toBe(0)
    expect(body.delinquent_count).toBe(1)
    expect(body.email!.body).toContain('Balance: $1200.00')
  })

  it('(k) stays chunked at 100 lease ids per .in() — O(ceil(N/100)) queries, never O(N)', async () => {
    const N = 250
    const rows = Array.from({ length: N }, (_, i) => ar(`lease_${i}`, 1200))
    // Every lease current: recent == balance.
    const charges = makeCharges({ recent: rows.map(r => ({ lease_id: r.lease_id, amount: 1200 })) })
    wire(rows, charges)
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body).toEqual({ late_fees_posted: 0, delinquent_count: 0, email: null })
    // 3 chunks for the recent-charges query + 3 for the existing-fee guard.
    expect(charges.selects.length).toBe(6)
    for (const s of charges.selects) {
      const inCall = s.calls.find(c => c.method === 'in')
      expect(inCall).toBeDefined()
      expect((inCall!.args[1] as string[]).length).toBeLessThanOrEqual(100)
    }
  })
})
