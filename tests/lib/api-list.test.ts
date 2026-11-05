import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetSession = vi.hoisted(() => vi.fn())

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}))

import { api } from '../../src/lib/api'

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mockGetSession.mockResolvedValue({ data: { session: null } })
})

describe('api.list', () => {
  it('builds the query string and returns { data, total }', async () => {
    const fetchMock = stubFetch({ data: [{ id: 1 }], total: 7 })
    const res = await api.list<{ id: number }>('/admin/tenants', {
      limit: 50,
      offset: 100,
      sort: 'name',
      dir: 'desc',
      q: 'acme',
      status: 'active',
    })
    expect(res).toEqual({ data: [{ id: 1 }], total: 7 })
    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://x')
    expect(url.pathname).toBe('/api/admin/tenants')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '50',
      offset: '100',
      sort: 'name',
      dir: 'desc',
      q: 'acme',
      status: 'active',
    })
  })

  it('omits undefined, null and empty-string values', async () => {
    const fetchMock = stubFetch({ data: [], total: 0 })
    await api.list('/admin/units', { limit: 25, offset: 0, sort: undefined, q: '', status: null })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/units?limit=25&offset=0')
  })

  it('adds no "?" when there are no params', async () => {
    const fetchMock = stubFetch({ data: [], total: 0 })
    await api.list('/admin/units', {})
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/units')
  })

  it('url-encodes values and keeps offset 0', async () => {
    const fetchMock = stubFetch({ data: [], total: 0 })
    await api.list('/admin/tenants', { offset: 0, q: 'a&b c' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/tenants?offset=0&q=a%26b+c')
  })

  it('appends with & when the path already has a query', async () => {
    const fetchMock = stubFetch({ data: [], total: 0 })
    await api.list('/admin/tenants?x=1', { limit: 5 })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/tenants?x=1&limit=5')
  })
})

describe('api.listAll', () => {
  function stubPages(pages: Array<{ data: unknown[]; total: number }>) {
    const fetchMock = vi.fn()
    for (const p of pages) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(p), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
    }
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }))

  it('pages with limit 200 until rows.length >= total and keeps caller params', async () => {
    const fetchMock = stubPages([
      { data: items(0, 200), total: 450 },
      { data: items(200, 200), total: 450 },
      { data: items(400, 50), total: 450 },
    ])
    const rows = await api.listAll<{ id: number }>('/tenants', { sort: 'name', dir: 'asc' })
    expect(rows).toHaveLength(450)
    expect(rows[449]).toEqual({ id: 449 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const urls = fetchMock.mock.calls.map((c) => new URL(c[0] as string, 'http://x'))
    expect(urls.map((u) => u.searchParams.get('offset'))).toEqual(['0', '200', '400'])
    for (const u of urls) {
      expect(u.searchParams.get('limit')).toBe('200')
      expect(u.searchParams.get('sort')).toBe('name')
      expect(u.searchParams.get('dir')).toBe('asc')
    }
  })

  it('makes a single request when everything fits', async () => {
    const fetchMock = stubPages([{ data: items(0, 3), total: 3 }])
    expect(await api.listAll('/properties')).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops on an empty page even if total is larger', async () => {
    const fetchMock = stubPages([
      { data: items(0, 200), total: 999 },
      { data: [], total: 999 },
    ])
    expect(await api.listAll('/tenants')).toHaveLength(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('hard-caps at 5,000 rows', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({ data: items(i * 200, 200), total: 100000 }))
    const fetchMock = stubPages(pages)
    const rows = await api.listAll('/tenants')
    expect(rows).toHaveLength(5000)
    expect(fetchMock).toHaveBeenCalledTimes(25)
  })

  it('overrides caller-supplied limit/offset', async () => {
    const fetchMock = stubPages([{ data: items(0, 1), total: 1 }])
    await api.listAll('/tenants', { limit: 5, offset: 9 })
    const u = new URL(fetchMock.mock.calls[0][0] as string, 'http://x')
    expect(u.searchParams.get('limit')).toBe('200')
    expect(u.searchParams.get('offset')).toBe('0')
  })
})
