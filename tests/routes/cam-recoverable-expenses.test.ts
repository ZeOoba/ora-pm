import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable, PG_MAX_ROWS, type Row } from '../fixtures/pg-table'

// GET /api/cam/recoverable-expenses — the property/year recoverable total that the CAM page sends to
// /cam/calculate. It used to be summed in the browser from GET /expenses, which returns one
// PaginationSchema page (50 rows by default, 200 max), so any property with more expenses than that
// fed a truncated total into every tenant's true-up.

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

const PROP = '11111111-1111-4111-8111-111111111111'
const OTHER_PROP = '22222222-2222-4222-8222-222222222222'
let seq = 0
const expense = (over: Row = {}): Row => ({
  id: `e_${String(seq++).padStart(7, '0')}`, property_id: PROP, expense_date: '2025-06-15', amount: 10, recoverable: true, category: 'maintenance', ...over,
})
function install(rows: Row[], opts: Parameters<typeof pgTable>[1] = {}) {
  const t = pgTable(rows, opts)
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'expenses') throw new Error(`unexpected table ${table}`)
    return t
  })
  return t
}
const get = (qs: string) => app.request(`/api/cam/recoverable-expenses?${qs}`, {}, env)
type Body = { data?: { total: number; count: number }; error?: unknown }

describe('GET /api/cam/recoverable-expenses', () => {
  it('totals EVERY recoverable expense for the year — past one PostgREST page, not a 50-row list page', async () => {
    const t = install(Array.from({ length: PG_MAX_ROWS + 1 }, () => expense()))

    const res = await get(`property_id=${PROP}&year=2025`)
    expect(res.status).toBe(200)
    expect((await res.json() as Body).data).toEqual({ total: (PG_MAX_ROWS + 1) * 10, count: PG_MAX_ROWS + 1, by_category: { taxes: 0, insurance: 0, maintenance: (PG_MAX_ROWS + 1) * 10, utilities: 0, management: 0, capital: 0, other: 0 } })
    expect(t.pages).toHaveLength(2)
    for (const page of t.pages) {
      expect(page.find(c => c.method === 'order')?.args[0]).toBe('id')
      expect(page.find(c => c.method === 'limit')?.args[0] as number).toBeLessThanOrEqual(PG_MAX_ROWS)
    }
  })

  it('counts only this property, recoverable rows, and dates inside the year — Jan 1 and Dec 31 inclusive', async () => {
    // The browser used `new Date(expense_date).getFullYear()`, which parses a DATE as UTC midnight and
    // reads it back in local (ET) time — so a Jan 1 expense landed in the PRIOR year's true-up.
    install([
      expense({ expense_date: '2025-01-01', amount: 1 }),
      expense({ expense_date: '2025-12-31', amount: 2 }),
      expense({ expense_date: '2024-12-31', amount: 100 }),
      expense({ expense_date: '2026-01-01', amount: 100 }),
      expense({ recoverable: false, amount: 100 }),
      expense({ property_id: OTHER_PROP, amount: 100 }),
    ])

    const body = await (await get(`property_id=${PROP}&year=2025`)).json() as Body
    expect(body.data).toEqual({ total: 3, count: 2, by_category: { taxes: 0, insurance: 0, maintenance: 3, utilities: 0, management: 0, capital: 0, other: 0 } })
  })

  it('rounds the float sum to cents', async () => {
    install([expense({ amount: 0.1 }), expense({ amount: 0.2 })])
    expect((await (await get(`property_id=${PROP}&year=2025`)).json() as Body).data!.total).toBe(0.3)
  })

  it('returns { total: 0, count: 0 } for a property/year with no recoverable expenses', async () => {
    install([])
    expect((await (await get(`property_id=${PROP}&year=2025`)).json() as Body).data).toEqual({ total: 0, count: 0, by_category: { taxes: 0, insurance: 0, maintenance: 0, utilities: 0, management: 0, capital: 0, other: 0 } })
  })

  it('returns 500 with a generic message and NO total when the read fails', async () => {
    install([expense()], { error: { message: 'relation "expenses" exploded' } })

    const res = await get(`property_id=${PROP}&year=2025`)
    expect(res.status).toBe(500)
    const body = await res.json() as Body
    expect(body.data).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('exploded')
  })

  it('fails closed (500) if a page does not advance the id cursor — never loops or double-counts', async () => {
    const t = install(Array.from({ length: PG_MAX_ROWS }, () => expense()), { ignoreGt: 'id' })

    const res = await get(`property_id=${PROP}&year=2025`)
    expect(res.status).toBe(500)
    expect(t.pages.length).toBeLessThanOrEqual(3)
  })

  it.each([
    ['missing property_id', 'year=2025'],
    ['non-uuid property_id', 'property_id=abc&year=2025'],
    ['missing year', `property_id=${PROP}`],
    ['non-integer year', `property_id=${PROP}&year=20x5`],
    ['out-of-range year', `property_id=${PROP}&year=99`],
  ])('returns 400 without querying for %s', async (_label, qs) => {
    install([expense()])
    const res = await get(qs)
    expect(res.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
