// tests/routes/expenses-total-amount.test.ts
//
// GET /api/expenses returns `total_amount` (2-decimal string) summed over ALL rows
// matching the filter, not just the current page. PostgREST caps rows per request,
// so the sum pages through select('amount') in chunks of 1000 and adds integer cents.

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

type Builder = Record<'select' | 'eq' | 'order' | 'range', Mock> & { then: unknown }

function builder(result: { data: unknown; count?: number | null; error?: unknown }): Builder {
  const b = {} as Builder
  for (const m of ['select', 'eq', 'order', 'range'] as const) b[m] = vi.fn().mockReturnValue(b)
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ error: null, count: null, ...result }).then(resolve, reject)
  return b
}

// First from() call = main page query; subsequent calls = amount chunks.
function wire(page: Builder, chunks: Builder[]) {
  const queue = [page, ...chunks]
  mockFrom.mockImplementation(() => queue.shift() ?? builder({ data: [] }))
}

const rows = (n: number, amount: string | number) => Array.from({ length: n }, () => ({ amount }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/expenses total_amount', () => {
  it('sums every chunk (1000 + 3 rows), not just the page, as a 2-decimal string', async () => {
    const page = builder({ data: [{ id: 'e1' }], count: 1003 })
    const c1 = builder({ data: rows(1000, '1.50') })
    const c2 = builder({ data: rows(3, '10.25') })
    wire(page, [c1, c2])
    const res = await app.request('/api/expenses?limit=1', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[]; total: number; total_amount: string }
    expect(body.total).toBe(1003)
    expect(body.total_amount).toBe('1530.75') // 1000*1.50 + 3*10.25
    expect(c1.range).toHaveBeenCalledWith(0, 999)
    expect(c2.range).toHaveBeenCalledWith(1000, 1999)
    expect(c1.select).toHaveBeenCalledWith('amount')
  })

  it('stops after a single short chunk', async () => {
    const page = builder({ data: [], count: 2 })
    const c1 = builder({ data: [{ amount: 5 }, { amount: '7.5' }] })
    wire(page, [c1])
    const body = (await (await app.request('/api/expenses', {}, env)).json()) as { total_amount: string }
    expect(body.total_amount).toBe('12.50')
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('applies the property_id filter to the page query and to every chunk', async () => {
    const page = builder({ data: [], count: 1001 })
    const c1 = builder({ data: rows(1000, 1) })
    const c2 = builder({ data: rows(1, 1) })
    wire(page, [c1, c2])
    await app.request('/api/expenses?property_id=prop-9', {}, env)
    for (const b of [page, c1, c2]) expect(b.eq).toHaveBeenCalledWith('property_id', 'prop-9')
  })

  it('does not filter chunks when no property_id is given', async () => {
    const page = builder({ data: [], count: 0 })
    const c1 = builder({ data: [] })
    wire(page, [c1])
    const body = (await (await app.request('/api/expenses', {}, env)).json()) as { total_amount: string }
    expect(c1.eq).not.toHaveBeenCalled()
    expect(body.total_amount).toBe('0.00')
  })

  it('sums in integer cents (0.1 + 0.2 = 0.30, not 0.30000000000000004)', async () => {
    const page = builder({ data: [], count: 3 })
    const c1 = builder({ data: [{ amount: 0.1 }, { amount: 0.2 }, { amount: '0.07' }] })
    wire(page, [c1])
    const body = (await (await app.request('/api/expenses', {}, env)).json()) as { total_amount: string }
    expect(body.total_amount).toBe('0.37')
  })

  it('returns a generic 500 when an amount chunk fails', async () => {
    const page = builder({ data: [], count: 1 })
    const c1 = builder({ data: null, error: { code: 'XX000', message: 'secret detail' } })
    wire(page, [c1])
    const res = await app.request('/api/expenses', {}, env)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })
})
