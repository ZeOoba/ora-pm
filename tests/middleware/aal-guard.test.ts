// tests/middleware/aal-guard.test.ts
//
// OI-045 (server-side gap): the browser SPA's post-login AAL2 gate
// (src/portal/PortalApp.tsx, src/portal/lib/mfa-guard.ts) only decides which
// React component renders — it provides zero protection against a direct
// API call with a valid bearer JWT. A tenant who has never completed TOTP
// verification (aal1, or no verified factor at all) could call
// PATCH /api/portal/autopay directly, bypassing MFA entirely, and attach a
// bank account for ACH autopay. This tests the new server-side
// requireAal2 middleware, which closes that gap independently of the SPA.

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { requireAal2 } from '../../server/middleware/aal-guard'

const mockGetAal = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({
    auth: { mfa: { getAuthenticatorAssuranceLevel: mockGetAal } },
  }),
}))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test' }

function makeApp() {
  const app = new Hono<{ Bindings: typeof env }>()
  app.use('/protected/*', requireAal2)
  app.patch('/protected/autopay', (c) => c.json({ ok: true }))
  return app
}

function req(app: Hono<{ Bindings: typeof env }>, jwt?: string) {
  return app.request('/protected/autopay', {
    method: 'PATCH',
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  }, env)
}

describe('requireAal2 middleware', () => {
  it('returns 401 with no Authorization header — never reaches the AAL check at all', async () => {
    const res = await req(makeApp())
    expect(res.status).toBe(401)
    expect(mockGetAal).not.toHaveBeenCalled()
  })

  it('blocks with 403 when the tenant has a verified TOTP factor but has not stepped up this session (aal1 -> aal2 required)', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    })
    const res = await req(makeApp(), 'valid_jwt')
    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/multi-factor|mfa|aal2/i)
  })

  it('allows through when the session has already completed AAL2 step-up', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    })
    const res = await req(makeApp(), 'valid_jwt')
    expect(res.status).toBe(200)
  })

  it('allows through when the tenant has no verified factor enrolled at all (nextLevel stays aal1)', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
      error: null,
    })
    const res = await req(makeApp(), 'valid_jwt')
    expect(res.status).toBe(200)
  })

  it('THE ACTUAL BYPASS THIS FIX CLOSES: a direct API call with a bare aal1 JWT and a verified factor never reaches the handler', async () => {
    // This is the exact PoC from the REFUTE finding: a tenant with a
    // verified TOTP factor who skips the browser UI entirely.
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    })
    const app = new Hono<{ Bindings: typeof env }>()
    app.use('/protected/*', requireAal2)
    const handlerSpy = vi.fn((c) => c.json({ ok: true }))
    app.patch('/protected/autopay', handlerSpy)

    const res = await req(app, 'valid_jwt')
    expect(res.status).toBe(403)
    expect(handlerSpy).not.toHaveBeenCalled()
  })

  it('fails CLOSED (403, not 200) when the AAL check itself errors', async () => {
    mockGetAal.mockResolvedValue({ data: null, error: { message: 'network error' } })
    const res = await req(makeApp(), 'valid_jwt')
    expect(res.status).toBe(403)
  })

  it('never leaks the raw error message when the AAL check fails', async () => {
    mockGetAal.mockResolvedValue({ data: null, error: { message: 'GoTrue instance internal-auth-7f3a unreachable' } })
    const res = await req(makeApp(), 'valid_jwt')
    const text = await res.text()
    expect(text).not.toContain('internal-auth-7f3a')
  })

  it('passes the bearer JWT through to getAuthenticatorAssuranceLevel, not the current-session-only zero-arg form', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    })
    await req(makeApp(), 'the_specific_jwt_123')
    expect(mockGetAal).toHaveBeenCalledWith('the_specific_jwt_123')
  })
})
