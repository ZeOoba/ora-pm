// tests/routes/reports-financials.test.ts
//
// GET /api/reports/cash-activity · /financials · /income-statement-12mo — the read-only report
// endpoints behind the AppFolio-style dashboard, Transactions page and report library.
// Admin-gated, input-validated (422), and fail-closed (500, no partial report) on any read error
// or malformed row.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(
    async (
      c: { req: { header: (n: string) => string | undefined }; json: (b: unknown, s: number) => Response },
      next: () => Promise<void>,
    ) => {
      if (!c.req.header('Authorization')) return c.json({ error: 'Missing Authorization header' }, 401)
      return next()
    },
  ),
}))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test' }
const app = createApp()
const AUTH = { Authorization: 'Bearer test' }
const P1 = '11111111-1111-4111-8111-111111111111'

const METHODS = ['select', 'gte', 'lte', 'is', 'in', 'gt', 'eq', 'order', 'limit'] as const
type Builder = Record<(typeof METHODS)[number], Mock> & { then: unknown }

// Returns `data` on the first await and [] afterwards (fetchAllPages stops on a short page anyway).
function builder(data: unknown[], error: unknown = null): Builder {
  const b = {} as Builder
  for (const m of METHODS) b[m] = vi.fn().mockReturnValue(b)
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: error ? null : data, error }).then(resolve, reject)
  return b
}

function wire(tables: Record<string, Builder>) {
  mockFrom.mockImplementation((t: string) => tables[t] ?? builder([]))
}

const get = (path: string, headers: Record<string, string> = AUTH) => app.request(`/api/reports${path}`, { headers }, env)

const LEASE_META = [{ id: 'L1', tenants: { name: 'Adkins Towing' }, units: { suite: '08A', property_id: P1, properties: { name: 'nbc-a' } } }]
const PAYMENTS = [
  { id: 'p1', lease_id: 'L1', payment_date: '2026-11-09', method: 'check', stripe_status: null, amount: '705.55', check_number: null, notes: null },
  { id: 'p2', lease_id: 'L1', payment_date: '2026-11-06', method: 'ach_stripe', stripe_status: 'processing', amount: '240.00', check_number: null, notes: null },
]
const EXPENSES = [
  { id: 'e1', property_id: P1, expense_date: '2026-11-04', category: 'other', amount: '240.00', vendor: 'Host Co', description: 'Web hosting', properties: { name: 'nbc-a' } },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/reports/cash-activity', () => {
  it('401s without admin auth', async () => {
    expect((await get('/cash-activity?from=2026-11-01&to=2026-11-09', {})).status).toBe(401)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('422s on a missing or reversed range and on bad property_ids', async () => {
    expect((await get('/cash-activity?to=2026-11-09')).status).toBe(422)
    expect((await get('/cash-activity?from=2026-11-10&to=2026-11-09')).status).toBe(422)
    expect((await get('/cash-activity?from=2026-11-01&to=2026-11-09&property_ids=x')).status).toBe(422)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns received cash in, cash out and totals portfolio-wide', async () => {
    wire({ payments: builder(PAYMENTS), expenses: builder(EXPENSES), leases: builder(LEASE_META) })
    const res = await get('/cash-activity?from=2026-11-01&to=2026-11-09')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string; amount: number }[]; totals: Record<string, number> }
    expect(body.data.map((r) => r.id)).toEqual(['p1', 'e1'])
    expect(body.totals).toEqual({ cash_in: 705.55, cash_out: 240, net: 465.55, pending_ach: 240 })
  })

  it('scopes to selected properties via units → leases', async () => {
    const units = builder([{ id: 'U1' }])
    const leases = builder([{ id: 'L1' }])
    const payments = builder(PAYMENTS)
    const expenses = builder(EXPENSES)
    // leases is read twice (ids, then metadata): first ids, then metadata rows.
    let leaseCalls = 0
    mockFrom.mockImplementation((t: string) => {
      if (t === 'units') return units
      if (t === 'leases') return ++leaseCalls === 1 ? leases : builder(LEASE_META)
      if (t === 'payments') return payments
      if (t === 'expenses') return expenses
      return builder([])
    })
    const res = await get(`/cash-activity?from=2026-11-01&to=2026-11-09&property_ids=${P1}`)
    expect(res.status).toBe(200)
    expect(units.in).toHaveBeenCalledWith('property_id', [P1])
    expect(leases.in).toHaveBeenCalledWith('unit_id', ['U1'])
    expect(payments.in).toHaveBeenCalledWith('lease_id', ['L1'])
    expect(expenses.in).toHaveBeenCalledWith('property_id', [P1])
  })

  it('500s with no partial data on a read error', async () => {
    wire({ payments: builder([], { message: 'boom' }), expenses: builder(EXPENSES) })
    const res = await get('/cash-activity?from=2026-11-01&to=2026-11-09')
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('705.55')
  })
})

describe('GET /api/reports/financials', () => {
  it('returns period and FYTD statements, excluding voided charges at the query', async () => {
    const charges = builder([
      { id: 'c1', lease_id: 'L1', charge_date: '2026-11-01', type: 'rent', amount: '1000' },
      { id: 'c2', lease_id: 'L1', charge_date: '2026-03-01', type: 'rent', amount: '1000' },
    ])
    wire({ charges, payments: builder(PAYMENTS), expenses: builder(EXPENSES) })
    const res = await get('/financials?from=2026-11-01&to=2026-11-09')
    expect(res.status).toBe(200)
    expect(charges.is).toHaveBeenCalledWith('voided_at', null)
    expect(charges.gte).toHaveBeenCalledWith('charge_date', '2026-01-01') // reads from FY start
    const body = (await res.json()) as {
      fytd_range: { from: string }
      income_statement: { period: { total_income: number; noi: number }; fytd: { total_income: number } }
      cash_flow: { period: { total_cash_in: number; pending_ach: number } }
    }
    expect(body.fytd_range.from).toBe('2026-01-01')
    expect(body.income_statement.period.total_income).toBe(1000)
    expect(body.income_statement.period.noi).toBe(760)
    expect(body.income_statement.fytd.total_income).toBe(2000)
    expect(body.cash_flow.period.total_cash_in).toBe(705.55)
    expect(body.cash_flow.period.pending_ach).toBe(240)
  })

  it('500s on a malformed amount rather than reading it as zero', async () => {
    wire({ charges: builder([{ id: 'c1', lease_id: 'L1', charge_date: '2026-11-01', type: 'rent', amount: '' }]) })
    expect((await get('/financials?from=2026-11-01&to=2026-11-09')).status).toBe(500)
  })
})

describe('GET /api/reports/income-statement-12mo', () => {
  it('422s on a bad through month', async () => {
    expect((await get('/income-statement-12mo?through=2026-13')).status).toBe(422)
    expect((await get('/income-statement-12mo')).status).toBe(422)
  })

  it('returns 12 monthly statements plus a total', async () => {
    wire({ charges: builder([{ id: 'c1', lease_id: 'L1', charge_date: '2026-11-01', type: 'rent', amount: '500' }]) })
    const res = await get('/income-statement-12mo?through=2026-11')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { months: string[]; statements: { total_income: number }[]; total: { total_income: number } }
    expect(body.months).toHaveLength(12)
    expect(body.statements[11].total_income).toBe(500)
    expect(body.total.total_income).toBe(500)
  })
})
