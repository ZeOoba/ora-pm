// tests/routes/list-endpoints.test.ts
//
// List API contract (Phase 1, Task 2): every paged list endpoint returns
// { data, total } where total is the full filtered row count (PostgREST
// count: 'exact'), applies range(offset, offset+limit-1), and honours
// sort/dir/q against an allow-list. Existing filters are preserved.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}
const app = createApp()

// Chainable, awaitable PostgREST builder double.
type Builder = Record<'select' | 'eq' | 'or' | 'order' | 'range', Mock> & { then: unknown }
type ListBody = { data: Array<Record<string, unknown>>; total: number }

function builder(result: { data: unknown; count?: number | null; error?: unknown }): Builder {
  const b = {} as Builder
  for (const m of ['select', 'eq', 'or', 'order', 'range'] as const) b[m] = vi.fn().mockReturnValue(b)
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ error: null, count: null, ...result }).then(resolve, reject)
  return b
}

function get(path: string) {
  return app.request(path, {}, env)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const ROWS = [{ id: 'r1' }, { id: 'r2' }]

type Case = {
  route: string
  table: string
  defaultOrder: [string, boolean]
  sortField: string
}

const CASES: Case[] = [
  { route: '/api/properties', table: 'properties', defaultOrder: ['name', true], sortField: 'city' },
  { route: '/api/tenants', table: 'tenants', defaultOrder: ['name', true], sortField: 'created_at' },
  { route: '/api/leases', table: 'leases', defaultOrder: ['end_date', true], sortField: 'base_rent_monthly' },
  { route: '/api/charges', table: 'charges', defaultOrder: ['charge_date', false], sortField: 'amount' },
  { route: '/api/payments', table: 'payments', defaultOrder: ['payment_date', false], sortField: 'amount' },
  { route: '/api/expenses', table: 'expenses', defaultOrder: ['expense_date', false], sortField: 'category' },
  { route: '/api/units', table: 'units', defaultOrder: ['suite', true], sortField: 'sf' },
  { route: '/api/insurance', table: 'insurance_certificates', defaultOrder: ['expiration_date', true], sortField: 'status' },
  { route: '/api/renewals', table: 'renewals', defaultOrder: ['expiration_date', true], sortField: 'target_decision_date' },
]

describe.each(CASES)('GET $route list contract', ({ route, table, defaultOrder, sortField }) => {
  it('returns { data, total } using the exact count and applies range(offset, offset+limit-1)', async () => {
    const b = builder({ data: ROWS, count: 137 })
    mockFrom.mockReturnValue(b)
    const res = await get(`${route}?limit=20&offset=40`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListBody
    expect(body.total).toBe(137)
    expect(body.data).toHaveLength(2)
    expect(mockFrom).toHaveBeenCalledWith(table)
    expect(b.range).toHaveBeenCalledWith(40, 59)
    // select(<existing select>, { count: 'exact' })
    expect(b.select.mock.calls[0][1]).toEqual({ count: 'exact' })
  })

  it('uses the pre-existing default order when no sort is given', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    const res = await get(`${route}?limit=50`)
    expect(res.status).toBe(200)
    expect(b.range).toHaveBeenCalledWith(0, 49)
    expect(b.order).toHaveBeenCalledWith(defaultOrder[0], { ascending: defaultOrder[1] })
  })

  it('falls back to total 0 when count is null', async () => {
    mockFrom.mockReturnValue(builder({ data: [], count: null }))
    const body = (await (await get(route)).json()) as ListBody
    expect(body).toEqual({ data: [], total: 0 })
  })

  it('applies sort/dir from the allow-list', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    const res = await get(`${route}?sort=${sortField}&dir=desc`)
    expect(res.status).toBe(200)
    expect(b.order).toHaveBeenCalledWith(sortField, { ascending: false })
  })

  it('rejects an unknown sort field with 422 and never queries', async () => {
    const res = await get(`${route}?sort=secret_col`)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'Invalid sort field' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects limit > 200 with 422', async () => {
    const res = await get(`${route}?limit=500`)
    expect(res.status).toBe(422)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns a generic 500 on a DB error', async () => {
    mockFrom.mockReturnValue(builder({ data: null, error: { code: 'XX000', message: 'boom internal detail' } }))
    const res = await get(route)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('boom')
  })
})

describe('default paging on the already-paged routes', () => {
  it.each(['/api/properties', '/api/tenants', '/api/leases', '/api/charges', '/api/payments', '/api/expenses'])(
    '%s defaults to limit 50 / offset 0',
    async (route) => {
      const b = builder({ data: ROWS, count: 2 })
      mockFrom.mockReturnValue(b)
      await get(route)
      expect(b.range).toHaveBeenCalledWith(0, 49)
    },
  )
})

describe('q search (properties, tenants)', () => {
  it('properties: ORs ilike across name, city, entity_llc', async () => {
    const b = builder({ data: ROWS, count: 1 })
    mockFrom.mockReturnValue(b)
    await get('/api/properties?q=acme')
    expect(b.or).toHaveBeenCalledWith('name.ilike."%acme%",city.ilike."%acme%",entity_llc.ilike."%acme%"')
  })

  it('tenants: ORs ilike across name, contact_name, contact_email', async () => {
    const b = builder({ data: ROWS, count: 1 })
    mockFrom.mockReturnValue(b)
    await get('/api/tenants?q=acme')
    expect(b.or).toHaveBeenCalledWith(
      'name.ilike."%acme%",contact_name.ilike."%acme%",contact_email.ilike."%acme%"',
    )
  })

  it('a hostile q yields a single or() call with exactly one clause per column', async () => {
    const b = builder({ data: [], count: 0 })
    mockFrom.mockReturnValue(b)
    await get(`/api/properties?q=${encodeURIComponent('x"),id.neq.0,(name.ilike."')}`)
    expect(b.or).toHaveBeenCalledTimes(1)
    const f: string = b.or.mock.calls[0][0]
    // Whole string must be exactly three well-formed quoted clauses: the
    // hostile quote/commas/parens never escape their quoted value.
    const clause = (col: string) => String.raw`${col}\.ilike\."%(?:[^"\\]|\\.)*%"`
    const re = new RegExp(`^${clause('name')},${clause('city')},${clause('entity_llc')}$`)
    expect(f).toMatch(re)
  })

  it('no q -> no or()', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    await get('/api/properties')
    expect(b.or).not.toHaveBeenCalled()
  })

  it('routes without searchColumns ignore q', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    await get('/api/leases?q=acme')
    expect(b.or).not.toHaveBeenCalled()
  })
})

describe('existing filters preserved', () => {
  it('leases: status filter applied when given, all statuses when absent', async () => {
    const b1 = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b1)
    await get('/api/leases?status=expired')
    expect(b1.eq).toHaveBeenCalledWith('status', 'expired')

    const b2 = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b2)
    await get('/api/leases')
    expect(b2.eq).not.toHaveBeenCalled()
  })

  it('charges: lease_id filter preserved', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    await get('/api/charges?lease_id=L1')
    expect(b.eq).toHaveBeenCalledWith('lease_id', 'L1')
  })

  it('payments: lease_id filter preserved', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    await get('/api/payments?lease_id=L1')
    expect(b.eq).toHaveBeenCalledWith('lease_id', 'L1')
  })

  it('expenses: property_id filter preserved', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    await get('/api/expenses?property_id=P1')
    expect(b.eq).toHaveBeenCalledWith('property_id', 'P1')
  })

  it('units: property_id filter preserved', async () => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    await get('/api/units?property_id=P1')
    expect(b.eq).toHaveBeenCalledWith('property_id', 'P1')
  })

  it('insurance: status is still enriched from expiration_date', async () => {
    const past = { id: 'c1', expiration_date: '2000-01-01', status: 'active' }
    mockFrom.mockReturnValue(builder({ data: [past], count: 1 }))
    const body = (await (await get('/api/insurance')).json()) as ListBody
    expect(body.total).toBe(1)
    expect(body.data[0].status).toBe('expired')
  })
})

describe('legacy unpaged routes (units, insurance, renewals)', () => {
  // These GETs previously returned every row with no paging, and the admin
  // forms (LeaseForm/LeaseIntake unit pickers) rely on that. With neither
  // limit nor offset supplied they must stay unpaged; total is still returned.
  it.each(['/api/units', '/api/insurance', '/api/renewals'])('%s: no range when limit/offset absent', async (route) => {
    const b = builder({ data: ROWS, count: 2 })
    mockFrom.mockReturnValue(b)
    const body = (await (await get(route)).json()) as ListBody
    expect(b.range).not.toHaveBeenCalled()
    expect(body.total).toBe(2)
  })
})
