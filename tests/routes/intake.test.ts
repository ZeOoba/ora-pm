import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { intakeRouter } from '../../server/routes/intake'
import { createApp } from '../../server/index'

const env = { ANTHROPIC_API_KEY: 'sk-test', CONFIDENTIAL_TERMS: 'zeta,99999' }
function app() { const a = new Hono(); a.route('/intake', intakeRouter); return a }
const body = (o: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) })

beforeEach(() => vi.restoreAllMocks())

describe('POST /intake/lease', () => {
  it('400 when required fields missing', async () => {
    const res = await app().request('/intake/lease', body({ filename: 'x.pdf' }), env)
    expect(res.status).toBe(400)
  })
  it('422 and NO fetch when filename hits the denylist', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await app().request('/intake/lease',
      body({ filename: 'Z_Zeta_lease.pdf', pdfBase64: 'X', tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('501 when ANTHROPIC_API_KEY is unset', async () => {
    const res = await app().request('/intake/lease',
      body({ filename: 'a.pdf', pdfBase64: 'X', tenant_id: 't', unit_id: 'u' }),
      { CONFIDENTIAL_TERMS: 'zeta' })
    expect(res.status).toBe(501)
  })
  it('200 returns extracted fields for a clean document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'extract_lease', input: { base_rent_monthly: 4500, _confidence: { base_rent_monthly: 0.97 } } }] }),
    }))
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'JVBERi0xLjcK', tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(200)
    const json = await res.json() as { fields: { base_rent_monthly: number } }
    expect(json.fields.base_rent_monthly).toBe(4500)
  })

  it('withholds a field whose extracted text hits the denylist (post-egress scrub)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'extract_lease', input: { notes: 'Tenant of the Zeta portfolio', base_rent_monthly: 4500, _confidence: {} } }] }),
    }))
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'JVBERi0xLjcK', tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(200)
    const json = await res.json() as { fields: Record<string, unknown>; warnings: string[] }
    expect(json.fields.notes).toBeUndefined()
    expect(json.fields.base_rent_monthly).toBe(4500)
    expect(json.warnings.some(w => /withheld/i.test(w))).toBe(true)
  })

  it('503 (fail-closed) when CONFIDENTIAL_TERMS is unset even with an API key — no fetch', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'JVBERi0xLjcK', tenant_id: 't', unit_id: 'u' }),
      { ANTHROPIC_API_KEY: 'sk-test' })
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('415 when the decoded payload is not a PDF', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'bm90LWEtcGRm', tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(415)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// The route is admin-gated by server/index.ts middleware (NOT in ADMIN_EXEMPT).
// This is the most security-load-bearing line in the change, so cover it against the REAL app.
describe('admin gating (real app)', () => {
  it('401 on /api/intake/lease when no Authorization header is present', async () => {
    const res = await createApp().request('/api/intake/lease',
      body({ filename: 'a.pdf', pdfBase64: 'X', tenant_id: 't', unit_id: 'u' }), {})
    expect(res.status).toBe(401)
  })
})
