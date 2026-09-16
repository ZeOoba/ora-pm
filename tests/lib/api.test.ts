import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetSession = vi.hoisted(() => vi.fn())

// Mock the Supabase client module so api.ts never touches import.meta.env / network.
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}))

import { api } from '../../src/lib/api'
import { ApiError, isDedupedConflict } from '../../src/lib/api-error'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

// OI-082 follow-up: request() used to throw a bare Error, discarding the
// response status and parsed body — a caller had no way to distinguish a
// 409 "already recorded" (an idempotent retry that's actually settled) from
// a genuine failure. It now throws ApiError, carrying both through.
describe('api.get/post — thrown errors carry status + body (ApiError)', () => {
  it('throws an ApiError with the response status and parsed body on a non-ok response', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok-123' } } })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Payment already recorded — this entry was submitted previously', deduped: true }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    let caught: unknown
    try {
      await api.post('/payments', { foo: 'bar' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApiError)
    const err = caught as ApiError
    expect(err.message).toBe('Payment already recorded — this entry was submitted previously')
    expect(err.status).toBe(409)
    expect(err.body).toEqual({ error: 'Payment already recorded — this entry was submitted previously', deduped: true })
  })

  it('still exposes .message for callers that only read that (backward compatible with plain Error usage)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Validation failed' }), { status: 422 }),
    ))

    await expect(api.post('/payments', {})).rejects.toThrow('Validation failed')
  })
})

describe('isDedupedConflict', () => {
  it('is true only for a 409 ApiError with body.deduped === true', () => {
    expect(isDedupedConflict(new ApiError('already recorded', 409, { deduped: true }))).toBe(true)
  })

  it('is false for a 409 without deduped:true', () => {
    expect(isDedupedConflict(new ApiError('conflict', 409, { error: 'conflict' }))).toBe(false)
  })

  it('is false for a non-409 ApiError even with deduped:true', () => {
    expect(isDedupedConflict(new ApiError('server error', 500, { deduped: true }))).toBe(false)
  })

  it('is false for a plain Error (not an ApiError)', () => {
    expect(isDedupedConflict(new Error('deduped'))).toBe(false)
  })

  it('is false for a non-Error throwable', () => {
    expect(isDedupedConflict('deduped')).toBe(false)
    expect(isDedupedConflict(undefined)).toBe(false)
  })
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
