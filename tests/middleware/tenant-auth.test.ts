import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { tenantAuthMiddleware } from '../../server/middleware/tenant-auth'

const mockGetUser = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({
    auth: { getUser: mockGetUser },
  }),
}))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test' }

function makeApp() {
  const app = new Hono<{ Bindings: typeof env }>()
  app.use('/protected/*', tenantAuthMiddleware)
  app.get('/protected/test', (c) => c.json({ userId: c.get('tenantUserId' as never) }))
  return app
}

describe('tenantAuthMiddleware', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await makeApp().request('/protected/test', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid JWT', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid JWT' } })

    const res = await makeApp().request('/protected/test', {
      headers: { Authorization: 'Bearer bad_token' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('passes through with valid JWT and sets tenantUserId', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user_abc' } }, error: null })

    const res = await makeApp().request('/protected/test', {
      headers: { Authorization: 'Bearer valid_jwt' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { userId: string }
    expect(body.userId).toBe('user_abc')
  })
})
