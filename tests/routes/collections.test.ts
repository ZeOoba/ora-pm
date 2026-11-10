import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

// In-memory PostgREST fake for the tables the collections router touches. Records every filter so
// tests can assert the conditional update (status = 'open') and the tenant join filter.
type Row = Record<string, unknown>
const store = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, log: [] as { table: string; op: string; filters: [string, unknown][] }[], seq: 0 }))

function query(table: string) {
  const filters: [string, unknown][] = []
  let op = 'select'
  let patch: Row | null = null
  let insertRow: Row | null = null
  let mode: 'many' | 'single' | 'maybe' = 'many'
  const rows = () => (store.tables[table] ??= [])
  const match = (r: Row) => filters.every(([c, v]) => {
    if (c.startsWith('leases.')) return (r.__tenant_id ?? null) === v
    return String(r[c]) === String(v)
  })
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => { filters.push([c, v]); return b },
    insert: (row: Row) => { op = 'insert'; insertRow = row; return b },
    update: (p: Row) => { op = 'update'; patch = p; return b },
    single: () => { mode = 'single'; return b },
    maybeSingle: () => { mode = 'maybe'; return b },
    then: (resolve: (v: unknown) => void) => {
      store.log.push({ table, op, filters: [...filters] })
      let out: Row[]
      if (op === 'insert') {
        const r = { id: `00000000-0000-4000-8000-${String(++store.seq).padStart(12, '0')}`, created_at: '2026-11-10T00:00:00Z', resolved_at: null, ...insertRow }
        rows().push(r)
        out = [r]
      } else if (op === 'update') {
        out = rows().filter(match)
        for (const r of out) Object.assign(r, patch)
      } else {
        out = rows().filter(match)
      }
      if (mode === 'single') return resolve(out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not one row' } })
      if (mode === 'maybe') return resolve({ data: out[0] ?? null, error: null })
      return resolve({ data: out, error: null })
    },
  }
  return b
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t: string) => query(t) }) }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('adminEmail', 'admin@example.test'); return next() }),
}))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test', CRON_SECRET: 'test', STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: 'whsec_dummy' }
const app = createApp()
const LEASE = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'

const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
const put = (path: string, body: unknown) => app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
const get = (path: string) => app.request(path, {}, env)

beforeEach(() => {
  store.tables = { leases: [{ id: LEASE, tenant_id: TENANT }], promises_to_pay: [], ar_disputes: [] }
  store.log = []
  store.seq = 0
})

describe('promises to pay', () => {
  it('records a promise as open, stamped with the admin, and reports lapsed=false for a future date', async () => {
    const res = await post('/api/collections/promises', { lease_id: LEASE, amount: 6340.18, promised_date: '2099-01-15', notes: 'Dana, by phone' })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: Row }
    expect(body.data).toMatchObject({ lease_id: LEASE, amount: 6340.18, status: 'open', created_by: 'admin@example.test', lapsed: false })
  })

  it.each([
    ['missing amount', { lease_id: LEASE, promised_date: '2026-12-01' }],
    ['zero amount', { lease_id: LEASE, amount: 0, promised_date: '2026-12-01' }],
    ['sub-cent amount', { lease_id: LEASE, amount: 1.234, promised_date: '2026-12-01' }],
    ['impossible date', { lease_id: LEASE, amount: 10, promised_date: '2026-02-31' }],
    ['non-uuid lease', { lease_id: 'abc', amount: 10, promised_date: '2026-12-01' }],
    ['mass-assigned status', { lease_id: LEASE, amount: 10, promised_date: '2026-12-01', status: 'kept' }],
    ['mass-assigned created_by', { lease_id: LEASE, amount: 10, promised_date: '2026-12-01', created_by: 'someone' }],
  ])('rejects %s with 422 and writes nothing', async (_n, body) => {
    const res = await post('/api/collections/promises', body)
    expect(res.status).toBe(422)
    expect(store.tables.promises_to_pay).toHaveLength(0)
  })

  it('404s for an unknown lease without inserting', async () => {
    const res = await post('/api/collections/promises', { lease_id: '33333333-3333-4333-8333-333333333333', amount: 10, promised_date: '2026-12-01' })
    expect(res.status).toBe(404)
    expect(store.tables.promises_to_pay).toHaveLength(0)
  })

  it('lists open promises with lapsed derived from the date, filtered by tenant through the lease join', async () => {
    store.tables.promises_to_pay.push(
      { id: 'p1', lease_id: LEASE, amount: 100, promised_date: '2020-01-01', status: 'open', __tenant_id: TENANT },
      { id: 'p2', lease_id: LEASE, amount: 200, promised_date: '2099-01-01', status: 'open', __tenant_id: TENANT },
      { id: 'p3', lease_id: LEASE, amount: 300, promised_date: '2020-01-01', status: 'kept', __tenant_id: TENANT },
    )
    const res = await get(`/api/collections/promises?tenant_id=${TENANT}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Row[] }
    expect(body.data.map((r) => [r.id, r.lapsed])).toEqual([['p1', true], ['p2', false]])
    expect(store.log.at(-1)?.filters).toEqual([['status', 'open'], ['leases.tenant_id', TENANT]])
  })

  it('status=all includes resolved; a resolved promise is never lapsed', async () => {
    store.tables.promises_to_pay.push({ id: 'p3', lease_id: LEASE, amount: 300, promised_date: '2020-01-01', status: 'kept' })
    const body = await (await get('/api/collections/promises?status=all')).json() as { data: Row[] }
    expect(body.data).toEqual([expect.objectContaining({ id: 'p3', lapsed: false })])
  })

  it('rejects unknown list params', async () => {
    expect((await get('/api/collections/promises?status=lapsed')).status).toBe(422)
    expect((await get('/api/collections/promises?foo=1')).status).toBe(422)
  })

  it('resolves only an open promise (conditional update), stamping who and when; a second resolve is 409', async () => {
    const id = '44444444-4444-4444-8444-444444444444'
    store.tables.promises_to_pay.push({ id, lease_id: LEASE, amount: 100, promised_date: '2026-11-05', status: 'open', resolved_at: null })
    const res = await put(`/api/collections/promises/${id}`, { status: 'broken' })
    expect(res.status).toBe(200)
    expect(store.log.find((l) => l.op === 'update')?.filters).toEqual([['id', id], ['status', 'open']])
    expect(store.tables.promises_to_pay[0]).toMatchObject({ status: 'broken', resolved_by: 'admin@example.test' })
    expect(store.tables.promises_to_pay[0].resolved_at).toEqual(expect.any(String))
    const again = await put(`/api/collections/promises/${id}`, { status: 'kept' })
    expect(again.status).toBe(409)
    expect(store.tables.promises_to_pay[0].status).toBe('broken')
  })

  it('cannot reopen, and 404s an unknown id', async () => {
    const id = '55555555-5555-4555-8555-555555555555'
    expect((await put(`/api/collections/promises/${id}`, { status: 'open' })).status).toBe(422)
    expect((await put(`/api/collections/promises/${id}`, { status: 'kept' })).status).toBe(404)
    expect((await put('/api/collections/promises/not-a-uuid', { status: 'kept' })).status).toBe(422)
  })
})

describe('AR disputes', () => {
  it('records a dispute with or without an amount; reason is required', async () => {
    const a = await post('/api/collections/disputes', { lease_id: LEASE, amount: 9880, reason: 'CAM 2025 reconciliation' })
    expect(a.status).toBe(201)
    const b = await post('/api/collections/disputes', { lease_id: LEASE, reason: 'Disputes the late fee' })
    expect(b.status).toBe(201)
    expect(((await b.json()) as { data: Row }).data.amount).toBeNull()
    expect((await post('/api/collections/disputes', { lease_id: LEASE, reason: '   ' })).status).toBe(422)
  })

  it('resolves with a resolution note; withdrawn and resolved are terminal', async () => {
    const id = '66666666-6666-4666-8666-666666666666'
    store.tables.ar_disputes.push({ id, lease_id: LEASE, reason: 'x', status: 'open', resolved_at: null })
    const res = await put(`/api/collections/disputes/${id}`, { status: 'resolved', resolution: 'Sent recon backup; tenant agreed' })
    expect(res.status).toBe(200)
    expect(store.tables.ar_disputes[0]).toMatchObject({ status: 'resolved', resolution: 'Sent recon backup; tenant agreed' })
    expect((await put(`/api/collections/disputes/${id}`, { status: 'withdrawn' })).status).toBe(409)
  })
})
