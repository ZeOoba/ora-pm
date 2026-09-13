import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable, PG_MAX_ROWS, type Row } from '../fixtures/pg-table'

// Bypass admin auth (same pattern as tests/routes/cam.test.ts) — this file tests the routes' reads,
// not the admin gate.
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test' }
const app = createApp()
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

type Tables = Record<string, ReturnType<typeof pgTable>>
function install(tables: Tables) {
  mockFrom.mockImplementation((table: string) => {
    if (!tables[table]) throw new Error(`unexpected table ${table}`)
    return tables[table]
  })
}

// Unique, bytewise-ascending ids (every table here has a uuid PK in production).
let seq = 0
const id = (p: string) => `${p}_${String(seq++).padStart(7, '0')}`
const PROP = 'prop_1'
const unit = (property_id = PROP): Row => ({ id: id('u'), property_id })
const lease = (unit_id: string, status = 'active'): Row => ({ id: id('l'), unit_id, status })
// `voided_at` (migration 0014, OI-278): null = live; a timestamp = voided (audit row, not money).
const charge = (lease_id: string, charge_date: string, type = 'rent', amount = 100, voided_at: string | null = null): Row =>
  ({ id: id('c'), lease_id, type, amount, charge_date, voided_at })
const expense = (expense_date: string, category = 'repairs', amount = 10): Row => ({ id: id('e'), property_id: PROP, category, amount, expense_date })

// The `.in(col, ids)` id lists a table was queried with — proves the list is chunked (URL length).
const inLists = (t: ReturnType<typeof pgTable>, col: string) =>
  t.pages.map(p => p.find(c => c.method === 'in' && c.args[0] === col)?.args[1] as unknown[]).filter(Boolean)

describe('GET /api/reports/actuals — PostgREST max_rows + error handling', () => {
  const get = () => app.request(`/api/reports/actuals?property_id=${PROP}&year=2026`, {}, env)
  type Body = { data?: Record<string, number>; error?: string }

  function world(opts: { units?: Row[]; leases?: Row[]; charges?: Row[]; expenses?: Row[]; errorOn?: string } = {}) {
    const err = { message: 'relation exploded' }
    const t: Tables = {
      units: pgTable(opts.units ?? [], opts.errorOn === 'units' ? { error: err } : {}),
      leases: pgTable(opts.leases ?? [], opts.errorOn === 'leases' ? { error: err } : {}),
      charges: pgTable(opts.charges ?? [], opts.errorOn === 'charges' ? { error: err } : {}),
      expenses: pgTable(opts.expenses ?? [], opts.errorOn === 'expenses' ? { error: err } : {}),
    }
    install(t)
    return t
  }

  it('counts EVERY charge in the year when a property has more than one PostgREST page of charges', async () => {
    // Direction: UNDER-REPORTED income. Pre-fix, rows past 1000 vanish from Budget vs Actual, 200.
    const u = unit(); const l = lease(u.id as string)
    const charges = Array.from({ length: PG_MAX_ROWS + 1 }, () => charge(l.id as string, '2026-03-01'))
    world({ units: [u], leases: [l], charges })

    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json() as Body).data!.rental_income).toBe((PG_MAX_ROWS + 1) * 100)
  })

  it('sums EVERY expense in the year when the property has more than one page of expenses', async () => {
    const expenses = Array.from({ length: PG_MAX_ROWS + 1 }, () => expense('2026-05-01'))
    world({ expenses })

    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json() as Body).data!.repairs).toBe((PG_MAX_ROWS + 1) * 10)
  })

  it('still counts charges on a lease that is no longer active (it billed during the year)', async () => {
    const u = unit(); const ended = lease(u.id as string, 'terminated')
    world({ units: [u], leases: [ended], charges: [charge(ended.id as string, '2026-01-01')] })

    expect((await (await get()).json() as Body).data!.rental_income).toBe(100)
  })

  // OI-278 / migration 0014: a voided charge is an audit row. Budget vs Actual must not report it
  // as income — the $50 voided late fee below would otherwise land in other_income.
  it('excludes voided charges from actuals (a voided late fee is not other_income)', async () => {
    const u = unit(); const l = lease(u.id as string)
    world({ units: [u], leases: [l], charges: [
      charge(l.id as string, '2026-03-01', 'rent', 1000),
      charge(l.id as string, '2026-03-02', 'late_fee', 50, '2026-09-13T12:00:00Z'),
      charge(l.id as string, '2026-03-02', 'late_fee', 50), // a live fee still counts
    ] })

    const res = await get()
    expect(res.status).toBe(200)
    const data = (await res.json() as Body).data!
    expect(data.rental_income).toBe(1000)
    expect(data.other_income).toBe(50)
  })

  it('chunks the lease_id list (no single unbounded .in() URL) and still counts every lease', async () => {
    const units = Array.from({ length: 150 }, () => unit())
    const leases = units.map(u => lease(u.id as string))
    const t = world({ units, leases, charges: leases.map(l => charge(l.id as string, '2026-02-01')) })

    const res = await get()
    expect((await res.json() as Body).data!.rental_income).toBe(150 * 100)
    for (const col of [['charges', 'lease_id'], ['leases', 'unit_id']] as const) {
      const lists = inLists(t[col[0]], col[1])
      expect(lists.length).toBeGreaterThan(1)
      for (const list of lists) expect(list.length).toBeLessThanOrEqual(100)
    }
  })

  it.each(['charges', 'expenses', 'units', 'leases'])('returns 500 (not $0 actuals) when the %s read fails', async (table) => {
    // Pre-fix the charges error was never read: a failed read reported zero income with a 200.
    const u = unit(); const l = lease(u.id as string)
    world({ units: [u], leases: [l], charges: [charge(l.id as string, '2026-03-01')], expenses: [expense('2026-03-01')], errorOn: table })

    const res = await get()
    expect(res.status).toBe(500)
    const body = await res.json() as Body
    expect(body.data).toBeUndefined()
    expect(body.error).not.toContain('relation exploded') // OI-042: generic message only
  })
})

describe('GET /api/exports/qb-iif — PostgREST max_rows + error handling', () => {
  const get = () => app.request(`/api/exports/qb-iif?property_id=${PROP}&year=2026&month=3`, {}, env)

  function world(opts: { properties?: Row[]; units?: Row[]; leases?: Row[]; charges?: Row[]; errorOn?: string } = {}) {
    const err = { message: 'relation exploded' }
    const t: Tables = {
      properties: pgTable(opts.properties ?? [{ id: PROP, name: 'Test Prop', entity_llc: 'Test LLC' }], opts.errorOn === 'properties' ? { error: err } : {}),
      units: pgTable(opts.units ?? [], opts.errorOn === 'units' ? { error: err } : {}),
      leases: pgTable(opts.leases ?? [], opts.errorOn === 'leases' ? { error: err } : {}),
      charges: pgTable(opts.charges ?? [], opts.errorOn === 'charges' ? { error: err } : {}),
    }
    install(t)
    return t
  }

  it('journals EVERY charge in the month when the property has more than one page of charges', async () => {
    // Direction: UNDER-STATED journal entry imported into QuickBooks, 200. (Income lines are IIF credits: negative.)
    const u = unit(); const l = lease(u.id as string)
    world({ units: [u], leases: [l], charges: Array.from({ length: PG_MAX_ROWS + 1 }, () => charge(l.id as string, '2026-03-01')) })

    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(`Rental Income:Base Rent\t-${((PG_MAX_ROWS + 1) * 100).toFixed(2)}\t`)
  })

  // OI-278 / migration 0014: a voided charge must never reach QuickBooks — the IIF journal is what
  // gets imported into the books, so a voided $50 fee here would post phantom Late Fee income.
  it('does not journal voided charges (a voided late fee produces no Late Fees line)', async () => {
    const u = unit(); const l = lease(u.id as string)
    world({ units: [u], leases: [l], charges: [
      charge(l.id as string, '2026-03-01', 'rent', 1000),
      charge(l.id as string, '2026-03-05', 'late_fee', 50, '2026-09-13T12:00:00Z'),
    ] })

    const res = await get()
    expect(res.status).toBe(200)
    const iif = await res.text()
    expect(iif).toContain('Rental Income:Base Rent\t-1000.00\t')
    expect(iif).not.toContain('Rental Income:Late Fees')
  })

  it('chunks the lease_id list and still journals every lease', async () => {
    const units = Array.from({ length: 150 }, () => unit())
    const leases = units.map(u => lease(u.id as string))
    const t = world({ units, leases, charges: leases.map(l => charge(l.id as string, '2026-03-15')) })

    const res = await get()
    expect(await res.text()).toContain(`Rental Income:Base Rent\t-${(150 * 100).toFixed(2)}\t`)
    for (const col of [['charges', 'lease_id'], ['leases', 'unit_id']] as const) {
      const lists = inLists(t[col[0]], col[1])
      expect(lists.length).toBeGreaterThan(1)
      for (const list of lists) expect(list.length).toBeLessThanOrEqual(100)
    }
  })

  it.each(['charges', 'units', 'leases', 'properties'])('returns 500 and NO IIF file when the %s read fails', async (table) => {
    // Pre-fix no read here checked its error: a failed charges read downloaded a $0 journal entry.
    const u = unit(); const l = lease(u.id as string)
    world({ units: [u], leases: [l], charges: [charge(l.id as string, '2026-03-01')], errorOn: table })

    const res = await get()
    expect(res.status).toBe(500)
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(await res.text()).not.toContain('relation exploded')
  })

  it('returns 404 and NO IIF file for an unknown property (not an "Unknown" journal entry)', async () => {
    world({ properties: [] })

    const res = await get()
    expect(res.status).toBe(404)
    expect(res.headers.get('content-disposition')).toBeNull()
  })
})
