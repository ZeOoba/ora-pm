import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'
import { buildStatement } from '../../server/lib/statement'
import { buildErrorKind } from '../../server/routes/statements'
import { pgTable, type Row } from '../fixtures/pg-table'

// /api/statements — per-lease statement, batch and Outlook draft packet. Admin auth is bypassed
// here (same pattern as reports-ar-aging-buckets.test.ts); admin-gate-coverage.test.ts owns the gate.
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test' }
const app = createApp()
const errSpy = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(errSpy)
  vi.spyOn(console, 'log').mockImplementation(errSpy)
})

type Tables = Record<string, ReturnType<typeof pgTable>>
let seq = 0
// UUID-shaped ids (the route rejects a non-uuid lease id with 422); the prefix only aids reading.
const PREFIX: Record<string, string> = { t: '1', l: '2', u: '3', c: '4', p: '5' }
const id = (p: string) => `${PREFIX[p] ?? '9'}0000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`
const MISSING_LEASE = '2fffffff-0000-4000-8000-000000000000'

const PROP = { id: 'prop_1', name: 'Test Park', address: '100 Main St', city: 'Columbus', state: 'OH', zip: '43215', entity_llc: 'Test Park Holdings LLC' }
const tenant = (over: Row = {}): Row => ({ id: id('t'), name: 'Acme Widgets Inc', contact_name: 'Pat Doe', contact_email: 'pat@acme.example', ...over })
const ledger = (t: Row, over: Row = {}): Row => ({
  lease_id: id('l'), tenant_id: t.id, tenant_name: t.name, unit_id: id('u'), property_id: PROP.id, property_name: PROP.name, suite: 'B2',
  total_charged: 0, total_paid: 0, balance: 0, ...over,
})
const charge = (lease_id: unknown, charge_date: string, amount: number | string, over: Row = {}): Row => ({
  id: id('c'), lease_id, charge_date, due_date: charge_date, type: 'rent', description: null, amount, voided_at: null, ...over,
})
const payment = (lease_id: unknown, payment_date: string, amount: number, over: Row = {}): Row => ({
  id: id('p'), lease_id, payment_date, amount, method: 'check', stripe_status: null, check_number: null, ...over,
})

const counted = (p: Row) => p.method !== 'ach_stripe' || p.stripe_status === 'succeeded'
const cents = (v: unknown) => Math.round(Number(v) * 100)
// Fixture invariant: ar_ledger totals derive from the charge/payment fixtures (as the view does).
function consistent(ledgerRows: Row[], charges: Row[], payments: Row[]): Row[] {
  return ledgerRows.map(r => {
    const tc = charges.filter(c => c.lease_id === r.lease_id && c.voided_at === null).reduce((a, c) => a + cents(c.amount), 0)
    const tp = payments.filter(p => p.lease_id === r.lease_id && counted(p)).reduce((a, p) => a + cents(p.amount), 0)
    return { ...r, total_charged: tc / 100, total_paid: tp / 100, balance: (tc - tp) / 100 }
  })
}

function world(w: { ledger: Row[]; tenants: Row[]; charges: Row[]; payments: Row[]; properties?: Row[]; raw?: boolean }) {
  const t: Tables = {
    ar_ledger: pgTable(w.raw ? w.ledger : consistent(w.ledger, w.charges, w.payments)),
    properties: pgTable(w.properties ?? [PROP]),
    tenants: pgTable(w.tenants),
    charges: pgTable(w.charges),
    payments: pgTable(w.payments),
  }
  mockFrom.mockImplementation((table: string) => {
    if (!t[table]) throw new Error(`unexpected table ${table}`)
    return t[table]
  })
  return t
}

const get = (path: string) => app.request(`/api/statements${path}`, {}, env)

type StatementBody = {
  data: {
    lease_id: string; entity_llc: string | null; contact_email: string | null; blockers: string[]
    statement: { openingCents: number; chargesCents: number; paymentsCents: number; closingCents: number; pendingCents: number; lines: unknown[] }
  }
}

describe('GET /api/statements/lease/:leaseId', () => {
  it('returns the statement with header fields, excluding voided charges', async () => {
    const t = tenant()
    const l = ledger(t)
    const charges = [charge(l.lease_id, '2026-09-01', 1000), charge(l.lease_id, '2026-10-01', 1000), charge(l.lease_id, '2026-10-05', 50, { voided_at: '2026-10-06T00:00:00Z', void_reason: 'x' })]
    const payments = [payment(l.lease_id, '2026-09-10', 1000), payment(l.lease_id, '2026-10-12', 250, { method: 'ach_stripe', stripe_status: 'processing' })]
    world({ ledger: [l], tenants: [t], charges, payments })
    const res = await get(`/lease/${l.lease_id}?start=2026-10-01&end=2026-10-31`)
    expect(res.status).toBe(200)
    const body = await res.json() as StatementBody
    expect(body.data.entity_llc).toBe('Test Park Holdings LLC')
    expect(body.data.statement).toMatchObject({ openingCents: 0, chargesCents: 100000, paymentsCents: 0, closingCents: 100000, pendingCents: 25000 })
    expect(body.data.blockers).toEqual([])
  })

  it('closes on ar_ledger.balance when end is after all activity', async () => {
    const t = tenant()
    const l = ledger(t)
    const charges = [charge(l.lease_id, '2026-08-01', 1200.5), charge(l.lease_id, '2026-09-01', 1200.5)]
    const payments = [payment(l.lease_id, '2026-08-03', 700.25), payment(l.lease_id, '2026-09-03', 100, { method: 'ach_stripe', stripe_status: 'succeeded' })]
    const [led] = consistent([l], charges, payments)
    world({ ledger: [l], tenants: [t], charges, payments })
    const body = await (await get(`/lease/${l.lease_id}?start=2026-09-01&end=2026-12-31`)).json() as StatementBody
    expect(body.data.statement.closingCents).toBe(cents(led.balance))
  })

  it('404 for an unknown lease', async () => {
    world({ ledger: [], tenants: [], charges: [], payments: [] })
    expect((await get(`/lease/${MISSING_LEASE}?start=2026-10-01&end=2026-10-31`)).status).toBe(404)
  })

  it('422 for a non-uuid lease id, without touching the database', async () => {
    world({ ledger: [], tenants: [], charges: [], payments: [] })
    expect((await get('/lease/nope?start=2026-10-01&end=2026-10-31')).status).toBe(422)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('422 for missing, malformed or inverted dates', async () => {
    world({ ledger: [], tenants: [], charges: [], payments: [] })
    for (const qs of ['', '?start=2026-10-01', '?start=2026-10-01&end=2026-13-01', '?start=2026-11-01&end=2026-10-01', '?start=10/01/2026&end=2026-10-31']) {
      expect((await get(`/lease/${MISSING_LEASE}${qs}`)).status).toBe(422)
    }
  })

  it('fails closed (500) when fetched charges do not tie to ar_ledger.total_charged, after one retry', async () => {
    const t = tenant()
    const l = ledger(t, { total_charged: 999, total_paid: 0, balance: 999 })
    const tables = world({ ledger: [l], tenants: [t], charges: [charge(l.lease_id, '2026-10-01', 1000)], payments: [], raw: true })
    const res = await get(`/lease/${l.lease_id}?start=2026-10-01&end=2026-10-31`)
    expect(res.status).toBe(500)
    expect(tables.ar_ledger.pages.length).toBe(2)
  })

  it('fails closed when counted payments do not tie to ar_ledger.total_paid', async () => {
    const t = tenant()
    const l = ledger(t, { total_charged: 10, total_paid: 0, balance: 10 })
    world({ ledger: [l], tenants: [t], charges: [charge(l.lease_id, '2026-10-01', 10)], payments: [payment(l.lease_id, '2026-10-02', 5)], raw: true })
    expect((await get(`/lease/${l.lease_id}?start=2026-10-01&end=2026-10-31`)).status).toBe(500)
  })

  it('fails closed on a non-numeric amount', async () => {
    const t = tenant()
    const l = ledger(t)
    world({ ledger: [{ ...l, total_charged: 0 }], tenants: [t], charges: [charge(l.lease_id, '2026-10-01', 'abc')], payments: [], raw: true })
    expect((await get(`/lease/${l.lease_id}?start=2026-10-01&end=2026-10-31`)).status).toBe(500)
  })

  it('never logs tenant PII or amounts on failure', async () => {
    const t = tenant()
    const l = ledger(t, { total_charged: 987.65, total_paid: 123.45 })
    world({ ledger: [l], tenants: [t], charges: [charge(l.lease_id, '2026-10-01', 4321.09)], payments: [payment(l.lease_id, '2026-10-02', 555.55)], raw: true })
    expect((await get(`/lease/${l.lease_id}?start=2026-10-01&end=2026-10-31`)).status).toBe(500)
    const logged = JSON.stringify(errSpy.mock.calls)
    expect(logged).toContain(String(l.lease_id))
    for (const s of ['pat@acme.example', 'Acme Widgets', 'Pat Doe', '98765', '987.65', '12345', '432109', '4321.09', '55555', '555.55']) {
      expect(logged).not.toContain(s)
    }
  })
})

describe('buildErrorKind — amount-free log classification', () => {
  const kindOf = (fn: () => unknown) => { try { fn(); return 'no throw' } catch (e) { return buildErrorKind((e as Error).message) } }
  it('classifies each buildStatement throw without echoing it', () => {
    expect(kindOf(() => buildStatement({ charges: [], payments: [], start: 'x', end: '2026-10-01' }))).toBe('malformed date')
    expect(kindOf(() => buildStatement({ charges: [], payments: [], start: '2026-10-31', end: '2026-10-01' }))).toBe('invalid range')
    expect(kindOf(() => buildStatement({ charges: [{ id: 'c', charge_date: '2026-10-01', due_date: '2026-10-01', type: 'rent', description: null, amountCents: 1.5 }], payments: [], start: '2026-10-01', end: '2026-10-31' }))).toBe('invalid amount')
    expect(buildErrorKind('statement does not foot: running 1 != closing 2')).toBe('does not foot')
    expect(buildErrorKind('something else 12345')).toBe('other')
  })
})

describe('GET /api/statements/batch', () => {
  it('lists every lease with a positive closing balance, with blockers', async () => {
    const good = tenant()
    const noEmail = tenant({ contact_email: null })
    const badEmail = tenant({ contact_email: 'a@b' })
    const paidUp = tenant()
    const otherProp = { ...PROP, id: 'prop_2', entity_llc: null }
    const lGood = ledger(good)
    const lNoEmail = ledger(noEmail)
    const lBad = ledger(badEmail)
    const lPaid = ledger(paidUp)
    const lNoLlc = ledger(good, { property_id: 'prop_2' })
    const charges = [lGood, lNoEmail, lBad, lPaid, lNoLlc].map(l => charge(l.lease_id, '2026-10-01', 500))
    const payments = [payment(lPaid.lease_id, '2026-10-02', 500)]
    world({ ledger: [lGood, lNoEmail, lBad, lPaid, lNoLlc], tenants: [good, noEmail, badEmail, paidUp], charges, payments, properties: [PROP, otherProp] })
    const res = await get('/batch?start=2026-10-01&end=2026-10-31')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: StatementBody['data'][] }
    const by = new Map(body.data.map(d => [d.lease_id, d]))
    expect(by.has(lPaid.lease_id as string)).toBe(false)
    expect(by.get(lGood.lease_id as string)!.blockers).toEqual([])
    expect(by.get(lNoEmail.lease_id as string)!.blockers).toEqual(['missing_contact_email'])
    expect(by.get(lBad.lease_id as string)!.blockers).toEqual(['invalid_contact_email'])
    expect(by.get(lNoLlc.lease_id as string)!.blockers).toEqual(['missing_entity_llc'])
  })

  it('uses the balance as of end, not today (a later payment does not drop the lease)', async () => {
    const t = tenant()
    const l = ledger(t)
    world({ ledger: [l], tenants: [t], charges: [charge(l.lease_id, '2026-10-01', 500)], payments: [payment(l.lease_id, '2026-11-05', 500)] })
    const body = await (await get('/batch?start=2026-10-01&end=2026-10-31')).json() as { data: unknown[] }
    expect(body.data).toHaveLength(1)
  })
})

describe('GET /api/statements/packet', () => {
  it('stages only unblocked statements; skipped carries lease id + reasons only', async () => {
    const good = tenant()
    const noEmail = tenant({ contact_email: '' })
    const lGood = ledger(good)
    const lNo = ledger(noEmail)
    world({ ledger: [lGood, lNo], tenants: [good, noEmail], charges: [charge(lGood.lease_id, '2026-10-01', 500), charge(lNo.lease_id, '2026-10-01', 500)], payments: [] })
    const res = await get('/packet?start=2026-10-01&end=2026-10-31')
    expect(res.status).toBe(200)
    const body = await res.json() as { version: number; start: string; end: string; items: { lease_id: string; to: string; subject: string; html: string }[]; skipped: Row[] }
    expect(body.version).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ lease_id: lGood.lease_id, to: 'pat@acme.example' })
    expect(body.items[0].subject).toContain('Statement of Account')
    expect(body.items[0].html).toContain('Test Park Holdings LLC')
    expect(body.items[0]).toMatchObject({ closing_cents: 50000 })
    expect(body.skipped).toEqual([{ lease_id: lNo.lease_id, closing_cents: 50000, reasons: ['missing_contact_email'] }])
  })

  it('trims the recipient address', async () => {
    const t = tenant({ contact_email: '  pat@acme.example ' })
    const l = ledger(t)
    world({ ledger: [l], tenants: [t], charges: [charge(l.lease_id, '2026-10-01', 500)], payments: [] })
    const body = await (await get('/packet?start=2026-10-01&end=2026-10-31')).json() as { items: { to: string }[] }
    expect(body.items[0].to).toBe('pat@acme.example')
  })
})
