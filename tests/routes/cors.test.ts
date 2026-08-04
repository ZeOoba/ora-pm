import { describe, it, expect } from 'vitest'
import { createApp } from '../../server/index'

// OI-037: server/index.ts previously mounted a bare `cors()` on /api/*, whose
// Hono default is `origin: '*'` — every /api/* route (including admin CRUD,
// portal, and Stripe endpoints) echoed Access-Control-Allow-Origin: * to any
// caller. This locks CORS down to an explicit allowlist.
describe('CORS allowlist (OI-037)', () => {
  it('does not echo an unrecognized Origin, and does not fall back to *', async () => {
    const app = createApp()
    const res = await app.request('/api/health', {
      headers: { Origin: 'https://evil.example' },
    })
    const allowOrigin = res.headers.get('Access-Control-Allow-Origin')
    expect(allowOrigin).not.toBe('https://evil.example')
    expect(allowOrigin).not.toBe('*')
    expect(allowOrigin).toBeNull()
  })

  it('echoes the origin back for an allowlisted production origin', async () => {
    const app = createApp()
    const res = await app.request('/api/health', {
      headers: { Origin: 'https://ora-pm.pages.dev' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://ora-pm.pages.dev')
  })

  it('echoes the origin back for local dev (localhost:5173)', async () => {
    const app = createApp()
    const res = await app.request('/api/health', {
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  })

  it('does not set Access-Control-Allow-Credentials (credentials: false)', async () => {
    const app = createApp()
    const res = await app.request('/api/health', {
      headers: { Origin: 'https://ora-pm.pages.dev' },
    })
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })
})
