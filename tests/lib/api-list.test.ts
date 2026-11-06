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

  it('keeps paging short pages while total > 0 (server max_rows below 200): 150 x 3 of 450', async () => {
    const fetchMock = stubPages([
      { data: items(0, 150), total: 450 },
      { data: items(150, 150), total: 450 },
      { data: items(300, 150), total: 450 },
    ])
    const rows = await api.listAll<{ id: number }>('/tenants')
    expect(rows).toHaveLength(450)
    expect(rows[449]).toEqual({ id: 449 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const offsets = fetchMock.mock.calls.map((c) => new URL(c[0] as string, 'http://x').searchParams.get('offset'))
    expect(offsets).toEqual(['0', '150', '300'])
  })

  it('stops on an empty page after short pages when total over-reports', async () => {
    const fetchMock = stubPages([
      { data: items(0, 200), total: 999 },
      { data: items(200, 120), total: 999 },
      { data: [], total: 999 },
    ])
    expect(await api.listAll('/tenants')).toHaveLength(320)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops on an empty first page', async () => {
    const fetchMock = stubPages([{ data: [], total: 0 }])
    expect(await api.listAll('/tenants')).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not stop after page 1 when total is 0 (null-count fallback): 200 then 50 rows', async () => {
    const fetchMock = stubPages([
      { data: items(0, 200), total: 0 },
      { data: items(200, 50), total: 0 },
    ])
    expect(await api.listAll('/tenants')).toHaveLength(250)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats an absent total like 0 (short-page fallback): 200 then 50 rows', async () => {
    const fetchMock = stubPages([
      { data: items(0, 200) } as { data: unknown[]; total: number },
      { data: items(200, 50) } as { data: unknown[]; total: number },
    ])
    expect(await api.listAll('/tenants')).toHaveLength(250)
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pages = Array.from({ length: 30 }, (_, i) => ({ data: items(i * 200, 200), total: 100000 }))
    const fetchMock = stubPages(pages)
    const rows = await api.listAll('/tenants')
    expect(rows).toHaveLength(5000)
    expect(fetchMock).toHaveBeenCalledTimes(25)
    expect(warn).toHaveBeenCalled()
  })

  it('overrides caller-supplied limit/offset', async () => {
    const fetchMock = stubPages([{ data: items(0, 1), total: 1 }])
    await api.listAll('/tenants', { limit: 5, offset: 9 })
    const u = new URL(fetchMock.mock.calls[0][0] as string, 'http://x')
    expect(u.searchParams.get('limit')).toBe('200')
    expect(u.searchParams.get('offset')).toBe('0')
  })
})

// Gate finding F-003: listAll offset-pages; a row inserted/removed between pages shifts later
// pages, so a picker can show a duplicate or miss a row. Simulated server, not canned pages.
describe('api.listAll under concurrent writes (F-003)', () => {
  type L = { id: string; status: string }
  function serveFrom(table: () => L[], afterCall: (n: number) => void) {
    let call = 0
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const offset = Number(u.searchParams.get('offset'))
      const limit = Number(u.searchParams.get('limit'))
      const active = table().filter((l) => l.status === 'active')
      const body = { data: active.slice(offset, offset + limit), total: active.length }
      afterCall(++call)
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const seed = (n: number): L[] => Array.from({ length: n }, (_, i) => ({ id: `L${String(i).padStart(4, '0')}`, status: 'active' }))
  const offsets = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.map((c) => new URL(c[0] as string, 'http://x').searchParams.get('offset'))

  it('a lease ended after page 1: re-fetches from the start and misses no still-active lease', async () => {
    const leases = seed(250)
    const fetchMock = serveFrom(() => leases, (n) => { if (n === 1) leases[10].status = 'ended' })
    const rows = await api.listAll<L>('/leases', { status: 'active' })
    const ids = rows.map((r) => r.id)
    const stillActive = leases.filter((l) => l.status === 'active').map((l) => l.id)
    expect(stillActive.filter((x) => !ids.includes(x))).toEqual([])
    expect(ids).not.toContain('L0010')
    expect(rows).toHaveLength(249)
    expect(offsets(fetchMock)).toEqual(['0', '200', '0', '200'])
  })

  it('a row inserted ahead of page 2: no duplicate ids, re-fetched from the start', async () => {
    const leases = seed(250)
    const fetchMock = serveFrom(() => leases, (n) => { if (n === 1) leases.unshift({ id: 'L-NEW', status: 'active' }) })
    const rows = await api.listAll<L>('/leases', { status: 'active' })
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('L-NEW')
    expect(rows).toHaveLength(251)
    expect(offsets(fetchMock)[2]).toBe('0')
  })

  it('persistent churn re-fetches only once and still returns de-duplicated rows', async () => {
    const leases = seed(250)
    let k = 0
    const fetchMock = serveFrom(() => leases, () => { leases.unshift({ id: `L-X${k++}`, status: 'active' }) })
    const rows = await api.listAll<L>('/leases')
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(offsets(fetchMock).filter((o) => o === '0')).toHaveLength(2)
  })
})
