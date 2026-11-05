import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable, PG_MAX_ROWS, type Row } from '../fixtures/pg-table'

// GET /api/reports/ar-aging — aging buckets (oldest-first allocation, OI-234). Bypass admin auth
// (same pattern as reports-exports-reads.test.ts): this file tests the bucket math, not the gate.
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test' }
const app = createApp()
const AS_OF_MS = Date.UTC(2026, 10, 5, 15, 0, 0) // 2026-11-05 15:00Z

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(AS_OF_MS)
})
afterEach(() => { vi.useRealTimers() })

type Tables = Record<string, ReturnType<typeof pgTable>>
function install(tables: Tables) {
  mockFrom.mockImplementation((table: string) => {
    if (!tables[table]) throw new Error(`unexpected table ${table}`)
    return tables[table]
  })
}

let seq = 0
const id = (p: string) => `${p}_${String(seq++).padStart(7, '0')}`
const daysAgo = (d: number) => new Date(Date.UTC(2026, 10, 5) - d * 86_400_000).toISOString().slice(0, 10)

const ledger = (balance: number | string, extra: Partial<Row> = {}): Row => ({
  lease_id: id('l'), tenant_id: id('t'), unit_id: id('u'), tenant_name: 'Acme Test LLC',
  property_id: 'prop_1', property_name: 'Test Park', suite: 'A1',
  total_charged: 0, total_paid: 0, balance, ...extra,
})
const charge = (lease_id: unknown, days: number, amount: number | string, voided_at: string | null = null): Row =>
  ({ id: id('c'), lease_id, amount, due_date: daysAgo(days), voided_at })

type Buckets = { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; unallocated: number }
type Body = { data?: (Row & { buckets: Buckets })[]; totals?: Buckets & { balance: number }; error?: string }
const get = (qs = '') => app.request(`/api/reports/ar-aging${qs}`, {}, env)
const cents = (n: number) => Math.round(n * 100)
const bucketSumCents = (b: Buckets) => cents(b.current) + cents(b.d1_30) + cents(b.d31_60) + cents(b.d61_90) + cents(b.d90_plus) + cents(b.unallocated)

function world(ledgerRows: Row[], charges: Row[], opts: { errorOn?: 'ar_ledger' | 'charges' } = {}) {
  const err = { message: 'relation exploded' }
  const t: Tables = {
    ar_ledger: pgTable(ledgerRows, opts.errorOn === 'ar_ledger' ? { error: err } : {}),
    charges: pgTable(charges, opts.errorOn === 'charges' ? { error: err } : {}),
  }
  install(t)
  return t
}

describe('GET /api/reports/ar-aging — buckets', () => {
  it('fixture with charges at 0/15/45/75/120 days: Σ buckets === balance per row and in totals', async () => {
    // Lease A: nothing paid. Lease B: 1250 paid against 5×500 → balance 1250, owed on the newest charges.
    const a = ledger(1500, { total_charged: 1500, total_paid: 0 })
    const b = ledger(1250, { total_charged: 2500, total_paid: 1250 })
    const charges = [
      charge(a.lease_id, 0, 100), charge(a.lease_id, 15, 200), charge(a.lease_id, 45, 300), charge(a.lease_id, 75, 400), charge(a.lease_id, 120, 500),
      ...[0, 15, 45, 75, 120].map(d => charge(b.lease_id, d, 500)),
    ]
    world([a, b], charges)

    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    const rowA = body.data!.find(r => r.lease_id === a.lease_id)!
    const rowB = body.data!.find(r => r.lease_id === b.lease_id)!
    expect(rowA.buckets).toEqual({ current: 100, d1_30: 200, d31_60: 300, d61_90: 400, d90_plus: 500, unallocated: 0 })
    expect(rowB.buckets).toEqual({ current: 500, d1_30: 500, d31_60: 250, d61_90: 0, d90_plus: 0, unallocated: 0 })
    for (const r of body.data!) expect(bucketSumCents(r.buckets)).toBe(cents(r.balance as number))

    expect(body.totals).toEqual({ balance: 2750, current: 600, d1_30: 700, d31_60: 550, d61_90: 400, d90_plus: 500, unallocated: 0 })
    expect(bucketSumCents(body.totals!)).toBe(cents(body.totals!.balance))
  })

  it('keeps every existing ar_ledger field on each row unchanged', async () => {
    const a = ledger(100, { total_charged: 300, total_paid: 200 })
    world([a], [charge(a.lease_id, 5, 300)])
    const row = (await (await get()).json() as Body).data![0]
    for (const [k, v] of Object.entries(a)) expect(row[k]).toEqual(v)
  })

  it('excludes voided charges (a voided newest charge does not absorb the balance)', async () => {
    const a = ledger(500)
    world([a], [charge(a.lease_id, 100, 500), charge(a.lease_id, 0, 50, '2026-09-13T12:00:00Z')])
    const row = (await (await get()).json() as Body).data![0]
    expect(row.buckets).toEqual({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 500, unallocated: 0 })
  })

  it('balance greater than Σ charges surfaces as unallocated (row and totals)', async () => {
    const a = ledger(700)
    world([a], [charge(a.lease_id, 10, 500)])
    const body = await (await get()).json() as Body
    expect(body.data![0].buckets).toEqual({ current: 0, d1_30: 500, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 200 })
    expect(body.totals!.unallocated).toBe(200)
  })

  it('string NUMERICs ("1234.10") are summed in cents, not concatenated or float-drifted', async () => {
    const a = ledger('1234.10'); const b = ledger('0.20'); const c = ledger('0.10')
    world([a, b, c], [charge(a.lease_id, 40, '1234.10'), charge(b.lease_id, 3, '0.20'), charge(c.lease_id, 3, '0.10')])
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    expect(body.data!.find(r => r.lease_id === a.lease_id)!.buckets.d31_60).toBe(1234.1)
    // 0.1 + 0.2 in floats is 0.30000000000000004; cents arithmetic gives exactly 0.3.
    expect(body.totals!.d1_30).toBe(0.3)
    expect(body.totals!.balance).toBe(1234.4)
    expect(bucketSumCents(body.totals!)).toBe(cents(body.totals!.balance))
  })

  it('reads EVERY charge when one lease chunk has more than a PostgREST page (keyset paging)', async () => {
    const a = ledger((PG_MAX_ROWS + 5) * 10)
    const charges = Array.from({ length: PG_MAX_ROWS + 5 }, (_, i) => charge(a.lease_id, 200 + (i % 50), 10))
    // The newest charge — sorted last by id, so it would land past row 1000 on a capped read.
    charges.push(charge(a.lease_id, 0, 10))
    const bal = (PG_MAX_ROWS + 6) * 10
    a.balance = bal
    world([a], charges)
    const res = await get()
    expect(res.status).toBe(200)
    const row = (await res.json() as Body).data![0]
    expect(row.buckets.current).toBe(10)
    expect(row.buckets.unallocated).toBe(0)
    expect(bucketSumCents(row.buckets)).toBe(cents(bal))
  })

  it('reads every AR row past one PostgREST page of ar_ledger', async () => {
    const rows = Array.from({ length: PG_MAX_ROWS + 3 }, () => ledger(10))
    world(rows, rows.map(r => charge(r.lease_id, 1, 10)))
    const body = await (await get()).json() as Body
    expect(body.data!.length).toBe(PG_MAX_ROWS + 3)
    expect(body.totals!.balance).toBe((PG_MAX_ROWS + 3) * 10)
    expect(body.totals!.d1_30).toBe((PG_MAX_ROWS + 3) * 10)
  })

  it('chunks the lease_id list (≤100 ids per .in())', async () => {
    const rows = Array.from({ length: 250 }, () => ledger(10))
    const t = world(rows, rows.map(r => charge(r.lease_id, 1, 10)))
    await get()
    const lists = t.charges.pages.map(p => p.find(c => c.method === 'in' && c.args[0] === 'lease_id')?.args[1] as unknown[]).filter(Boolean)
    expect(lists.length).toBeGreaterThan(1)
    for (const l of lists) expect(l.length).toBeLessThanOrEqual(100)
    // and the charge read filters out voided rows
    for (const p of t.charges.pages) expect(p.some(c => c.method === 'is' && c.args[0] === 'voided_at' && c.args[1] === null)).toBe(true)
  })

  it('passes the property filter through to ar_ledger', async () => {
    const a = ledger(10, { property_id: 'prop_1' }); const b = ledger(20, { property_id: 'prop_2' })
    world([a, b], [charge(a.lease_id, 1, 10), charge(b.lease_id, 1, 20)])
    const body = await (await get('?property_id=prop_2')).json() as Body
    expect(body.data!.map(r => r.lease_id)).toEqual([b.lease_id])
    expect(body.totals!.balance).toBe(20)
  })

  it('no AR rows: empty data and zero totals', async () => {
    world([], [])
    const body = await (await get()).json() as Body
    expect(body.data).toEqual([])
    expect(body.totals).toEqual({ balance: 0, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 })
  })

  it('returns 500 (not a silently wrong bucket) on a non-numeric charge amount', async () => {
    const a = ledger(100)
    world([a], [charge(a.lease_id, 1, 'abc')])
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json() as Body).data).toBeUndefined()
  })

  it('returns 500 on a non-numeric ledger balance', async () => {
    const a = ledger(100)
    a.balance = 'NaN-ish'
    world([a], [charge(a.lease_id, 1, 100)])
    // pgTable's `.gt('balance', 0)` compares strings bytewise; 'NaN-ish' > '0' so the row comes back.
    expect((await get()).status).toBe(500)
  })

  it('returns 500 on a malformed charge due_date', async () => {
    const a = ledger(100)
    const c = charge(a.lease_id, 1, 100); c.due_date = '2026-02-30'
    world([a], [c])
    expect((await get()).status).toBe(500)
  })

  it.each(['ar_ledger', 'charges'] as const)('returns 500 when the %s read fails', async (table) => {
    const a = ledger(100)
    world([a], [charge(a.lease_id, 1, 100)], { errorOn: table })
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json() as Body).data).toBeUndefined()
  })
})
