// tests/routes/expenses-total-amount.test.ts
//
// GET /api/expenses returns `total_amount` (2-decimal string) summed over ALL rows
// matching the filter, not just the current page. PostgREST caps rows per request
// (possibly below 1000), so the sum keyset-pages select('id, amount') ordered by id
// (.gt('id', lastId).limit(1000)) until a chunk returns 0 rows, adding integer cents.

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

type Builder = Record<'select' | 'eq' | 'order' | 'range' | 'gt' | 'limit', Mock> & { then: unknown }

function builder(result: { data: unknown; count?: number | null; error?: unknown }): Builder {
  const b = {} as Builder
  for (const m of ['select', 'eq', 'order', 'range', 'gt', 'limit'] as const) b[m] = vi.fn().mockReturnValue(b)
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ error: null, count: null, ...result }).then(resolve, reject)
  return b
}

// First from() call = main page query; subsequent calls = amount chunks.
function wire(page: Builder, chunks: Builder[]) {
  const queue = [page, ...chunks]
  mockFrom.mockImplementation(() => queue.shift() ?? builder({ data: [] }))
}

// Rows with sequential ids so keyset paging can be asserted.
const rows = (n: number, amount: string | number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${from + i}`, amount }))
const lastId = (r: Array<{ id: string }>) => r[r.length - 1].id
type Body = { data: unknown[]; total: number; total_amount?: string }
const getBody = async (path = '/api/expenses') => (await app.request(path, {}, env)).json() as Promise<Body>

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/expenses total_amount (keyset paging)', () => {
  it('sums chunks of 500,500,0 (server max_rows < 1000) to the full total', async () => {
    const page = builder({ data: [{ id: 'e1' }], count: 1000 })
    wire(page, [builder({ data: rows(500, '2.00') }), builder({ data: rows(500, '3.00', 500) }), builder({ data: [] })])
    const body = await getBody('/api/expenses?limit=1')
    expect(body.total).toBe(1000)
    expect(body.total_amount).toBe('2500.00') // 500*2 + 500*3, not a partial 1000.00
  })

  it('handles exactly 1000 rows then an empty chunk', async () => {
    const page = builder({ data: [], count: 1000 })
    wire(page, [builder({ data: rows(1000, '1.50') }), builder({ data: [] })])
    const body = await getBody()
    expect(body.total_amount).toBe('1500.00')
    expect(mockFrom).toHaveBeenCalledTimes(3)
  })

  it('returns 0.00 for an empty table', async () => {
    wire(builder({ data: [], count: 0 }), [builder({ data: [] })])
    expect((await getBody()).total_amount).toBe('0.00')
  })

  it('chunk 1 has no .gt; chunk 2+ use .order(id) and .gt(id, last id of previous chunk), .limit(1000)', async () => {
    const r1 = rows(400, 1)
    const r2 = rows(300, 1, 400)
    const c1 = builder({ data: r1 })
    const c2 = builder({ data: r2 })
    const c3 = builder({ data: [] })
    wire(builder({ data: [], count: 700 }), [c1, c2, c3])
    await getBody()
    expect(c1.select).toHaveBeenCalledWith('id, amount')
    for (const c of [c1, c2, c3]) {
      expect(c.order).toHaveBeenCalledWith('id')
      expect(c.limit).toHaveBeenCalledWith(1000)
    }
    expect(c1.gt).not.toHaveBeenCalled()
    expect(c2.gt).toHaveBeenCalledWith('id', lastId(r1))
    expect(c3.gt).toHaveBeenCalledWith('id', lastId(r2))
  })

  it('applies the property_id filter to the page query and to every chunk', async () => {
    const page = builder({ data: [], count: 2 })
    const c1 = builder({ data: rows(1, 1) })
    const c2 = builder({ data: [] })
    wire(page, [c1, c2])
    await getBody('/api/expenses?property_id=prop-9')
    for (const b of [page, c1, c2]) expect(b.eq).toHaveBeenCalledWith('property_id', 'prop-9')
  })

  it('does not filter chunks when no property_id is given', async () => {
    const c1 = builder({ data: [] })
    wire(builder({ data: [], count: 0 }), [c1])
    await getBody()
    expect(c1.eq).not.toHaveBeenCalled()
  })

  it('sums in integer cents (0.1 + 0.2 + 0.07 = 0.37)', async () => {
    const data = [
      { id: 'a', amount: 0.1 },
      { id: 'b', amount: 0.2 },
      { id: 'c', amount: '0.07' },
    ]
    wire(builder({ data: [], count: 3 }), [builder({ data }), builder({ data: [] })])
    expect((await getBody()).total_amount).toBe('0.37')
  })

  it('returns a generic 500 with no total_amount when chunk 2 fails', async () => {
    wire(builder({ data: [], count: 5 }), [
      builder({ data: rows(5, 1) }),
      builder({ data: null, error: { code: 'XX000', message: 'secret detail' } }),
    ])
    const res = await app.request('/api/expenses', {}, env)
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('secret')
    expect(text).not.toContain('total_amount')
  })

  it('returns 500 (no silent skip) when an amount is not a finite number', async () => {
    wire(builder({ data: [], count: 1 }), [builder({ data: [{ id: 'a', amount: 'abc' }] })])
    const res = await app.request('/api/expenses', {}, env)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('total_amount')
  })

  it('returns 500 when the 200-chunk safety cap is exceeded', async () => {
    const page = builder({ data: [], count: 1 })
    let n = 0
    mockFrom.mockImplementation(() => {
      if (n++ === 0) return page
      return builder({ data: [{ id: `id-${n}`, amount: 1 }] })
    })
    const res = await app.request('/api/expenses', {}, env)
    expect(res.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(201) // page + exactly 200 chunks
  })
})
