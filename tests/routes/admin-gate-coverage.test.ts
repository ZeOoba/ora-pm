import { describe, it, expect } from 'vitest'
import { createApp, isAdminExempt } from '../../server/index'

// M13 (2026-11-08 audit): the admin gate exempted paths with a bare `startsWith`, so any path that
// merely began with an exempt prefix ("/api/portalX", "/api/stripe-x", "/api/cronjob") skipped
// adminAuthMiddleware. No such route exists today, which is exactly why it would go unnoticed the
// day one is added. Exemption is now on a path-segment boundary, and this file enumerates the
// app's real routes: every non-exempt route must answer 401 from the admin gate, and every route
// under an exempt root (other than the public health check and the signature-verified webhook)
// must answer 401 from its OWN router's auth, so an unauthenticated handler added under an exempt
// root fails here too.

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  ADMIN_EMAILS: 'ggoldberg@oxfordra.net',
  CRON_SECRET: 'test',
}

const app = createApp()

describe('admin gate: segment-boundary exemption (M13)', () => {
  it.each([
    '/api/portalX',
    '/api/portal-admin',
    '/api/stripe-x',
    '/api/stripeadmin/keys',
    '/api/cronjob',
    '/api/health-detail',
    '/api/webhooksadmin',
  ])('%s is NOT exempt: it hits the admin gate (401 without a JWT)', async (path) => {
    const res = await app.request(path, { method: 'GET' }, env)
    expect(res.status).toBe(401)
  })

  it('exact exempt roots and their sub-paths are still exempt; look-alike prefixes are not', async () => {
    for (const p of ['/api/portal', '/api/portal/me', '/api/portal/insurance/x', '/api/stripe/payment-intent',
      '/api/cron/monthly-billing', '/api/webhooks/stripe', '/api/health']) {
      expect(isAdminExempt(p)).toBe(true)
    }
    for (const p of ['/api/portalX', '/api/stripe-x', '/api/cronjob', '/api/healthz', '/api/webhooks2', '/api/admin/tenants/x/invite', '/api/properties']) {
      expect(isAdminExempt(p)).toBe(false)
    }
    // /api/health is public and answers 200 with no JWT.
    expect((await app.request('/api/health', {}, env)).status).toBe(200)
  })

  it('every registered non-exempt /api route rejects a request with no JWT (401)', async () => {
    const routes = app.routes.filter(
      (r) => r.method !== 'ALL' && r.path.startsWith('/api/') && !isAdminExempt(r.path),
    )
    // Sanity: the enumeration is actually seeing the admin routers.
    expect(routes.length).toBeGreaterThan(20)
    const leaks: string[] = []
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, '00000000-0000-0000-0000-000000000000')
      const res = await app.request(path, { method: r.method }, env)
      if (res.status !== 401) leaks.push(`${r.method} ${r.path} -> ${res.status}`)
    }
    expect(leaks).toEqual([])
  })

  it('every route under an exempt root, except /api/health and the Stripe webhook, enforces its own auth (401 with none)', async () => {
    const PUBLIC = new Set(['/api/health', '/api/webhooks/stripe'])
    const routes = app.routes.filter(
      (r) => r.method !== 'ALL' && r.path.startsWith('/api/') && isAdminExempt(r.path) && !PUBLIC.has(r.path),
    )
    expect(routes.length).toBeGreaterThan(5)
    const open: string[] = []
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, '00000000-0000-0000-0000-000000000000')
      const res = await app.request(path, { method: r.method }, env)
      if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`)
    }
    expect(open).toEqual([])
  })
})
