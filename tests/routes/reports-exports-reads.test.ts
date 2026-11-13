import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
// `voided_at` (migration 0016, OI-278): null = live; a timestamp = voided (audit row, not money).
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

  // OI-278 / migration 0016: a voided charge is an audit row. Budget vs Actual must not report it
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

  // OI-278 / migration 0016: a voided charge must never reach QuickBooks — the IIF journal is what
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

// ---------------------------------------------------------------------------
// 2026-11-12 audit findings 2 and 3. The IIF journal is what gets imported into QuickBooks (the
// books of record), so it must journal EVERY live charge of the period exactly once:
//   #2 percentage_rent, other (tax/insurance escrows, manual adjustments) and security_deposit
//      used to fall through the classifier and vanish while the entry stayed balanced;
//   #3 only leases whose CURRENT status was 'active' were read, so re-exporting a past month
//      dropped every lease that has since ended.
// The charge-type list is read from the charges.type CHECK in migration 0002 (the database's own
// enum), so a type added there without an account mapping fails this table, not QuickBooks.
// ---------------------------------------------------------------------------
const CHARGE_TYPE_CHECK = readFileSync(join(__dirname, '../../supabase/migrations/0002_financial_tables.sql'), 'utf8')
  .match(/type TEXT NOT NULL CHECK \(type IN \(([^)]*)\)\)/)
const DB_CHARGE_TYPES = [...(CHARGE_TYPE_CHECK?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(m => m[1])

// The test's own expectation, written out per type — not imported from the code under test.
const EXPECTED_CREDIT_ACCOUNT: Record<string, string> = {
  rent: 'Rental Income:Base Rent',
  cam_estimate: 'Rental Income:CAM',
  cam_true_up: 'Rental Income:CAM',
  late_fee: 'Rental Income:Late Fees',
  security_deposit: 'Security Deposits Held',
  utility_water: 'Rental Income:Utilities',
  utility_gas: 'Rental Income:Utilities',
  utility_electric: 'Rental Income:Utilities',
  utility_other: 'Rental Income:Utilities',
  percentage_rent: 'Rental Income:Percentage Rent',
  other: 'Rental Income:Other',
}

describe('GET /api/exports/qb-iif — every charge type and every lease status (audit 2026-11-12 #2, #3)', () => {
  const get = () => app.request(`/api/exports/qb-iif?property_id=${PROP}&year=2026&month=3`, {}, env)
  function world(leases: Row[], units: Row[], charges: Row[]) {
    install({
      properties: pgTable([{ id: PROP, name: 'Test Prop', entity_llc: 'Test LLC' }]),
      units: pgTable(units),
      leases: pgTable(leases),
      charges: pgTable(charges),
    })
  }
  // AR is the TRNS (debit) line; each credit is an SPL line.
  const arDebit = (iif: string) => iif.split('\n').find(l => l.startsWith('TRNS\t'))?.split('\t')[4]
  const creditsBy = (iif: string) => {
    const out: Record<string, string> = {}
    for (const l of iif.split('\n').filter(x => x.startsWith('SPL\t'))) {
      const f = l.split('\t')
      out[f[3]] = f[4]
    }
    return out
  }

  it('reads the full charge-type enum from migration 0002 and has an expected account for each', () => {
    expect(DB_CHARGE_TYPES.length).toBe(11)
    expect(Object.keys(EXPECTED_CREDIT_ACCOUNT).sort()).toEqual([...DB_CHARGE_TYPES].sort())
  })

  it.each(DB_CHARGE_TYPES)('journals a lone %s charge: AR debit and the mapped credit, both for the full amount', async (type) => {
    const u = unit(); const l = lease(u.id as string)
    world([l], [u], [charge(l.id as string, '2026-03-10', type, 123.45)])

    const res = await get()
    expect(res.status).toBe(200)
    const iif = await res.text()
    expect(arDebit(iif)).toBe('123.45')
    expect(creditsBy(iif)).toEqual({ [EXPECTED_CREDIT_ACCOUNT[type]]: '-123.45' })
  })

  it('the AR debit equals the sum of ALL live charges of every type, and credits balance it', async () => {
    const u = unit(); const l = lease(u.id as string)
    const charges = DB_CHARGE_TYPES.map((type, i) => charge(l.id as string, '2026-03-02', type, 100 + i + 0.01))
    world([l], [u], [...charges, charge(l.id as string, '2026-03-02', 'other', 999, '2026-09-13T12:00:00Z')])

    const res = await get()
    expect(res.status).toBe(200)
    const iif = await res.text()
    const totalCents = charges.reduce((s, c) => s + Math.round((c.amount as number) * 100), 0)
    expect(arDebit(iif)).toBe((totalCents / 100).toFixed(2))
    const creditCents = Object.values(creditsBy(iif)).reduce((s, v) => s + Math.round(Number(v) * 100), 0)
    expect(creditCents).toBe(-totalCents)
  })

  it('refuses the export (500, no file) when a charge has a type with no account mapping, instead of dropping it', async () => {
    const u = unit(); const l = lease(u.id as string)
    world([l], [u], [charge(l.id as string, '2026-03-10', 'rent', 1000), charge(l.id as string, '2026-03-10', 'mystery_type', 5)])

    const res = await get()
    expect(res.status).toBe(500)
    expect(res.headers.get('content-disposition')).toBeNull()
    expect((await res.json() as { error: string }).error).toMatch(/mystery_type/)
  })

  it('still scopes to the month and the property once the lease status filter is gone', async () => {
    const u = unit(); const other = unit('prop_other')
    const l = lease(u.id as string, 'terminated'); const lo = lease(other.id as string)
    world([l, lo], [u, other], [
      charge(l.id as string, '2026-03-31', 'rent', 1000),
      charge(l.id as string, '2026-02-28', 'rent', 11),   // previous month
      charge(l.id as string, '2026-04-01', 'rent', 22),   // next month
      charge(lo.id as string, '2026-03-15', 'rent', 33),  // another property
    ])

    const iif = await (await get()).text()
    expect(arDebit(iif)).toBe('1000.00')
  })

  it.each(['terminated', 'expired', 'pending'])('journals a charge in the month from a lease whose status is now %s', async (status) => {
    const u = unit(); const live = lease(u.id as string); const ended = lease(u.id as string, status)
    world([live, ended], [u], [
      charge(live.id as string, '2026-03-01', 'rent', 1000),
      charge(ended.id as string, '2026-03-01', 'rent', 700),
    ])

    const res = await get()
    expect(res.status).toBe(200)
    const iif = await res.text()
    expect(arDebit(iif)).toBe('1700.00')
    expect(creditsBy(iif)).toEqual({ 'Rental Income:Base Rent': '-1700.00' })
  })
})
