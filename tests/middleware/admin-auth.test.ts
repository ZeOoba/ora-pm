import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { adminAuthMiddleware } from '../../server/middleware/admin-auth'

const mockGetUser = vi.hoisted(() => vi.fn())
const mockMaybeSingle = vi.hoisted(() => vi.fn())
const mockFrom = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  ADMIN_EMAILS: 'ggoldberg@oxfordra.net, egoldberg@oxfordra.net',
}

function makeApp() {
  const app = new Hono<{ Bindings: typeof env }>()
  app.use('/*', adminAuthMiddleware)
  app.get('/ping', (c) => c.json({ ok: true }))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no tenant row matches the authenticated user (not a tenant).
  mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: mockMaybeSingle,
      }),
    }),
  })
})

describe('adminAuthMiddleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = makeApp()
    const res = await app.request('/ping', {}, env)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/missing/i)
  })

  it('returns 401 when Authorization header has empty token', async () => {
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer ' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns 401 when JWT is invalid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid jwt' } })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer bad-token' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns 401 when getUser returns null user with no error', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer revoked-token' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns 403 when authenticated user email is not in ADMIN_EMAILS (RED 1)', async () => {
    // random@oxfordra.net is a valid domain but not on the allowlist — the old
    // suffix check would have passed this; the allowlist must reject it.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'random@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, env)
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/forbidden/i)
  })

  it('returns 403 when the email is allowlisted but a tenants row shares the auth_user_id (RED 2)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'tenant_1' }, error: null })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, env)
    expect(res.status).toBe(403)
    expect(mockFrom).toHaveBeenCalledWith('tenants')
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/forbidden/i)
  })

  it('returns 503 when ADMIN_EMAILS is unset (RED 3)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const unsetEnv = { ...env, ADMIN_EMAILS: undefined }
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, unsetEnv)
    expect(res.status).toBe(503)
  })

  it('returns 503 when ADMIN_EMAILS is an empty string (RED 3)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const emptyEnv = { ...env, ADMIN_EMAILS: '' }
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, emptyEnv)
    expect(res.status).toBe(503)
  })

  it('allows through an allowlisted admin who is not a tenant (RED 4)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer valid-token' },
    }, env)
    expect(res.status).toBe(200)
  })

  it('allowlist match is case-insensitive', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'GGoldberg@OxfordRA.net' } },
      error: null,
    })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer valid-token' },
    }, env)
    expect(res.status).toBe(200)
  })
})
