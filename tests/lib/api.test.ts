import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetSession = vi.hoisted(() => vi.fn())

// Mock the Supabase client module so api.ts never touches import.meta.env / network.
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}))

import { api } from '../../src/lib/api'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('api.download', () => {
  it('attaches the Authorization header from the Supabase session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok-123' } } })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('IIF-DATA', {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="JE-2026-06.iif"' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { blob, filename } = await api.download(
      '/exports/qb-iif?property_id=p1&year=2026&month=6',
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/exports/qb-iif?property_id=p1&year=2026&month=6')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
    expect(filename).toBe('JE-2026-06.iif')
    expect(await blob.text()).toBe('IIF-DATA')
  })

  it('throws the server error message when the response is not ok', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.download('/exports/qb-iif')).rejects.toThrow('Missing Authorization header')
  })

  it('omits the Authorization header and uses the fallback filename when there is no session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })
    const fetchMock = vi.fn().mockResolvedValue(new Response('x', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { filename } = await api.download('/exports/qb-iif', 'export.iif')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect('Authorization' in (init.headers as object)).toBe(false)
    expect(filename).toBe('export.iif')
  })
})
