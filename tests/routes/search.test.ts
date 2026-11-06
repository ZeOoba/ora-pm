// tests/routes/search.test.ts
//
// GET /api/search?q= — global command-palette search. Admin-authenticated (NOT in
// the auth-exempt list), q trimmed 2-100 chars (else 422), LIKE-escaped via the
// shared list-query helper, max 20 results overall.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

// Auth: reject when no Authorization header (mirrors the real middleware's 401),
// otherwise pass. Proves /api/search sits behind the admin gate.
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

type Builder = Record<'select' | 'or' | 'in' | 'order' | 'limit', Mock> & { then: unknown }
function builder(data: unknown, error: unknown = null): Builder {
  const b = {} as Builder
  for (const m of ['select', 'or', 'in', 'order', 'limit'] as const) b[m] = vi.fn().mockReturnValue(b)
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve, reject)
  return b
}

function wire(tables: Record<string, Builder>) {
  mockFrom.mockImplementation((t: string) => tables[t] ?? builder([]))
}

const get = (qs: string, headers: Record<string, string> = AUTH) => app.request(`/api/search${qs}`, { headers }, env)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/search', () => {
  it('401s without admin auth (not in the exempt list)', async () => {
    const res = await get('?q=acme', {})
    expect(res.status).toBe(401)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('422s on a 1-char q', async () => {
    expect((await get('?q=a')).status).toBe(422)
  })

  it('422s on a 1-char q after trimming', async () => {
    expect((await get('?q=%20a%20')).status).toBe(422)
  })

  it('422s on a 101-char q and on missing q', async () => {
    expect((await get(`?q=${'a'.repeat(101)}`)).status).toBe(422)
    expect((await get('')).status).toBe(422)
  })

  it('accepts exactly 100 chars', async () => {
    wire({})
    expect((await get(`?q=${'a'.repeat(100)}`)).status).toBe(200)
  })

  it('maps each entity type to its href and label', async () => {
    wire({
      properties: builder([{ id: 'p1', name: 'Acme Test Park', city: 'Dayton', state: 'OH' }]),
      tenants: builder([{ id: 't1', name: 'Acme Test LLC' }]),
      units: builder([{ id: 'u1', suite: 'A-100', property_id: 'p9', properties: { name: 'Acme Test Park' } }]),
      leases: builder([
        { id: 'l1', tenants: { name: 'Acme Test LLC' }, units: { suite: 'A-100', properties: { name: 'Acme Test Park' } } },
      ]),
    })
    const res = await get('?q=acme')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toEqual([
      { type: 'property', id: 'p1', label: 'Acme Test Park', sublabel: 'Dayton, OH', href: '/properties/p1' },
      { type: 'tenant', id: 't1', label: 'Acme Test LLC', sublabel: '', href: '/tenants/t1' },
      { type: 'unit', id: 'u1', label: 'A-100', sublabel: 'Acme Test Park', href: '/properties/p9' },
      { type: 'lease', id: 'l1', label: 'Acme Test LLC', sublabel: 'Acme Test Park · A-100', href: '/leases/l1' },
    ])
  })

  it('finds leases via matching tenant ids', async () => {
    const leases = builder([])
    wire({ tenants: builder([{ id: 't1', name: 'Acme Test LLC' }, { id: 't2', name: 'Acme Two LLC' }]), leases })
    await get('?q=acme')
    expect(leases.in).toHaveBeenCalledWith('tenant_id', ['t1', 't2'])
  })

  it('orders the capped lease query deterministically (order by id before limit)', async () => {
    const leases = builder([])
    wire({ tenants: builder([{ id: 't1', name: 'Acme Test LLC' }]), leases })
    await get('?q=acme')
    expect(leases.order).toHaveBeenCalledWith('id')
    expect(leases.limit).toHaveBeenCalledWith(8)
    expect(leases.order.mock.invocationCallOrder[0]).toBeLessThan(leases.limit.mock.invocationCallOrder[0])
  })

  it('skips the lease query when no tenant matches', async () => {
    wire({ tenants: builder([]) })
    await get('?q=zzz')
    expect(mockFrom).not.toHaveBeenCalledWith('leases')
  })

  it('escapes LIKE wildcards and quotes via the shared escaper', async () => {
    const props = builder([])
    wire({ properties: props })
    await get(`?q=${encodeURIComponent('50%_a"b,c')}`)
    const filter = props.or.mock.calls[0][0] as string
    expect(filter).toBe('name.ilike."%50\\\\%\\\\_a\\"b,c%"')
  })

  it('caps the combined result at 20', async () => {
    const many = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}`, city: 'x', state: 'y' }))
    wire({
      properties: builder(many(15, 'p')),
      tenants: builder(many(15, 't')),
      units: builder(many(15, 'u')),
      leases: builder(many(15, 'l')),
    })
    const res = await get('?q=acme')
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toHaveLength(20)
  })

  it('returns a generic 500 when a query fails', async () => {
    wire({ properties: builder(null, { message: 'boom secret' }) })
    const res = await get('?q=acme')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('boom secret')
  })
})
