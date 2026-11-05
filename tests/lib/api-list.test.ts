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
