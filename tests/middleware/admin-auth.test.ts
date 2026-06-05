import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { adminAuthMiddleware } from '../../server/middleware/admin-auth'

const mockGetUser = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
}

function makeApp() {
  const app = new Hono<{ Bindings: typeof env }>()
  app.use('/*', adminAuthMiddleware)
  app.get('/ping', (c) => c.json({ ok: true }))
  return app
}

beforeEach(() => vi.clearAllMocks())

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

  it('returns 403 when user email is not @oxfordra.net', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'outsider@gmail.com' } },
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

  it('allows through @oxfordra.net users', async () => {
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
})
