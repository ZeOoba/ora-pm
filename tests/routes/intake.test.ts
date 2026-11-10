import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { intakeRouter } from '../../server/routes/intake'
import { createApp } from '../../server/index'
import { buildTextPdf, buildImageOnlyPdf, buildMultiPagePdf, buildImagePlusFooterPdf, buildFormFieldPdf, toBase64 } from '../fixtures/pdf'
import { buildRefuteProbes, buildLinkUrlTermPdf, buildZeroPagePdf, BENIGN_LINE } from '../fixtures/refute-pdfs'

const env = { ANTHROPIC_API_KEY: 'sk-test', CONFIDENTIAL_TERMS: 'zeta,99999' }
function app() { const a = new Hono(); a.route('/intake', intakeRouter); return a }
const body = (o: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) })

// ---------------------------------------------------------------------------
// Rate limiter — mocked so the existing/route-wiring tests below aren't
// coupled to the real KV/memory counting algorithm (that's covered in
// isolation by tests/lib/rate-limit.test.ts). Default: always allow;
// individual tests override with mockResolvedValueOnce for the 429 case.
// ---------------------------------------------------------------------------
vi.mock('../../server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}))
import { checkRateLimit } from '../../server/lib/rate-limit'

// ---------------------------------------------------------------------------
// DB (tenant_id/unit_id existence check, OI-044 item 6) — mocked. Default:
// both 't' (tenant) and 'u' (unit) — the ids every pre-existing test in this
// file already uses — resolve as EXISTING, so this change is transparent to
// tests that don't care about the binding check. dbState lets individual
// tests flip either to "not found" for RED 5.
// ---------------------------------------------------------------------------
const dbState = { tenantExists: true, unitExists: true }
const mockDb = {
  from: vi.fn((table: string) => {
    if (table === 'tenants') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockImplementation(async () =>
              dbState.tenantExists ? { data: { id: 't' }, error: null } : { data: null, error: null }
            ),
          }),
        }),
      }
    }
    if (table === 'units') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockImplementation(async () =>
              dbState.unitExists ? { data: { id: 'u' }, error: null } : { data: null, error: null }
            ),
          }),
        }),
      }
    }
    return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }
  }),
}
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => mockDb) }))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.mocked(checkRateLimit).mockImplementation(async () => ({ allowed: true, retryAfterMs: 0 }))
  dbState.tenantExists = true
  dbState.unitExists = true
})

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
    const pdfBytes = await buildTextPdf('Ordinary lease terms, nothing sensitive here')
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(200)
    const json = await res.json() as { fields: { base_rent_monthly: number } }
    expect(json.fields.base_rent_monthly).toBe(4500)
  })

  it('withholds a field whose extracted text hits the denylist (post-egress scrub)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'extract_lease', input: { notes: 'Tenant of the Zeta portfolio', base_rent_monthly: 4500, _confidence: {} } }] }),
    }))
    const pdfBytes = await buildTextPdf('Ordinary lease terms, nothing sensitive here')
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
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

  // No pre-existing dedicated test for this cap (checked: absent from this
  // file at HEAD) — adding one since task-6-brief.md names it explicitly
  // among the protections that must "stay green" through this change, and
  // it's now sequenced ahead of the new content-scan step (server/routes/
  // intake.ts) so an oversized upload never reaches PDF extraction either.
  it('413 when the decoded payload exceeds the 10 MB cap', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const oversized = 'JVBER' + 'A'.repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3))
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: oversized, tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// RED 2 — INTAKE_MODEL allowlist + daily rate limit (OI-038 remainder)
// ---------------------------------------------------------------------------
describe('INTAKE_MODEL allowlist', () => {
  it('silently falls back to the default model when INTAKE_MODEL is not on the allowlist (does not reject the request)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const pdfBytes = await buildTextPdf('Ordinary lease terms, nothing sensitive here')
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }),
      { ...env, INTAKE_MODEL: 'some-untrusted-model-id' })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { model: string }
    expect(sentBody.model).not.toBe('some-untrusted-model-id')
    expect(sentBody.model).toBe('claude-opus-5') // DEFAULT_MODEL
  })

  it('honors INTAKE_MODEL when it IS on the allowlist', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const pdfBytes = await buildTextPdf('Ordinary lease terms, nothing sensitive here')
    await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }),
      { ...env, INTAKE_MODEL: 'claude-sonnet-5' })
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { model: string }
    expect(sentBody.model).toBe('claude-sonnet-5')
  })
})

describe('daily intake rate limit (OI-038 remainder)', () => {
  it('429 when checkRateLimit denies the request — and no fetch (no egress)', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterMs: 3_600_000 })
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'JVBERi0xLjcK', tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(429)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is keyed with the intake scope and a 24h window', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [] }) }))
    await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'JVBERi0xLjcK', tenant_id: 't', unit_id: 'u' }), env)
    expect(checkRateLimit).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
      expect.objectContaining({ scope: 'intake', maxCalls: 10, windowMs: 24 * 60 * 60 * 1000 }),
    )
  })
})

// ---------------------------------------------------------------------------
// RED 3 / RED 4 — OI-044: PDF CONTENT scan (not just filename), pre-egress
// ---------------------------------------------------------------------------
describe('PDF content confidentiality scan (OI-044)', () => {
  it('RED 3: 422 when the EXTRACTED TEXT hits the denylist even though the filename is clean — and extraction is never called (no egress)', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const pdfBytes = await buildTextPdf('Confidential lease for the Zeta acquisition')
    const res = await app().request('/intake/lease',
      body({ filename: 'acme-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(422)
    // Load-bearing assertion: the Anthropic-bound extraction call was NEVER
    // made — the content match must block before any egress, not merely
    // return the right status code.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('RED 4: an image-only PDF (no extractable text) is BLOCKED, not fail-open — the content scan cannot run, so the request never egresses', async () => {
    // REFUTE-pass correction (2026-08-03): the prior version of this test
    // asserted 200/fail-open, on the premise that four "compensating
    // controls" made proceeding safe. They don't: admin-gating and the
    // tenant/unit existence check are orthogonal to confidentiality (a real
    // confidential deal's tenant/unit legitimately exist), and the upload-UI
    // attestation was never actually enforced server-side (grep confirms it
    // exists only in comments). Extraction ran BEFORE the warning was ever
    // surfaced, so "fail open with a warning" was functionally "no check at
    // all" for this document class, for an admin-authenticated confidential
    // deal document. Blocking here mirrors the existing manual-entry fallback
    // UX this route already uses for extraction failures (502 below).
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const pdfBytes = await buildImageOnlyPdf()
    const res = await app().request('/intake/lease',
      body({ filename: 'scanned-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(422)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/content scan unavailable/i)
    // Load-bearing assertion, same as RED 3: no egress for a document the
    // scan couldn't clear.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a clean, real PDF with extractable text and no denylist hit proceeds with NO content-scan warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'extract_lease', input: { base_rent_monthly: 4500, _confidence: {} } }] }),
    }))
    const pdfBytes = await buildTextPdf('Ordinary lease terms, nothing sensitive here')
    const res = await app().request('/intake/lease',
      body({ filename: 'clean.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(200)
    const json = await res.json() as { warnings: string[] }
    expect(json.warnings).not.toContain('Content scan unavailable (image-based PDF) — filename-only screening applied')
  })
})

// ---------------------------------------------------------------------------
// RED 5 — OI-044 item 6: tenant_id/unit_id must actually EXIST, not just be present
// ---------------------------------------------------------------------------
describe('tenant/unit existence check (OI-044)', () => {
  it('RED 5: 404 when tenant_id does not exist — no egress attempted', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    dbState.tenantExists = false
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'JVBERi0xLjcK', tenant_id: 'nonexistent-tenant', unit_id: 'u' }), env)
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404 when unit_id does not exist — no egress attempted', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    dbState.unitExists = false
    const res = await app().request('/intake/lease',
      body({ filename: 'acme.pdf', pdfBase64: 'JVBERi0xLjcK', tenant_id: 't', unit_id: 'nonexistent-unit' }), env)
    expect(res.status).toBe(404)
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

// ---------------------------------------------------------------------------
// Audit finding intake-partial-text-layer-egress: the content scan used to pass
// as soon as the MERGED text was non-empty, so a typed cover page in front of
// scanned (image-only) lease pages cleared the scan on the cover page alone and
// the WHOLE PDF, scanned pages included, egressed to api.anthropic.com.
// The gate is now per page: every page must carry a real text layer.
// ---------------------------------------------------------------------------
describe('per-page text-layer gate (partial text layer)', () => {
  it('422 and NO egress when one page has text but another is image-only', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const pdfBytes = await buildMultiPagePdf(['Commercial lease cover sheet for the premises', null])
    const res = await app().request('/intake/lease',
      body({ filename: 'acme-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(422)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/content scan unavailable/i)
    expect(json.error).toMatch(/page\(s\) 2\b/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('422 and NO egress when a page carries only a stray stamp below the text threshold', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const pdfBytes = await buildMultiPagePdf(['Commercial lease cover sheet for the premises', 'Page 2 of 9'])
    const res = await app().request('/intake/lease',
      body({ filename: 'acme-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('422 and NO egress when the confidential term appears only on a later page', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const pdfBytes = await buildMultiPagePdf([
      'Commercial lease cover sheet for the premises',
      'Assignment to the Zeta acquisition vehicle at closing',
    ])
    const res = await app().request('/intake/lease',
      body({ filename: 'acme-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(422)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/confidential/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('200 for a multi-page document whose every page has a clean text layer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'extract_lease', input: { base_rent_monthly: 4500, _confidence: {} } }] }),
    }))
    const pdfBytes = await buildMultiPagePdf([
      'Commercial lease cover sheet for the premises',
      'Base rent schedule and the term of the lease',
    ])
    const res = await app().request('/intake/lease',
      body({ filename: 'acme-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// REFUTE C1b + round 2: a PDF can paint content pdf.js never extracts (images, form-field and
// annotation appearances, a lying ToUnicode map, outlined glyphs, Type3 image glyphs...). Instead
// of trying to detect every such construct, the request to Anthropic now carries ONLY the scanned
// per-page text: whatever pdf.js could not see is never sent. Annotation/form-field text is still
// scanned for terms (blocks), but it is not part of the outgoing text either.
// ---------------------------------------------------------------------------
type SentRequest = { messages: Array<{ content: Array<{ type: string; text?: string }> }> }
function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'extract_lease', input: { base_rent_monthly: 4500, _confidence: {} } }] }),
  })
}
function sentBody(fetchMock: ReturnType<typeof vi.fn>): { raw: string; json: SentRequest } {
  const raw = (fetchMock.mock.calls[0][1] as RequestInit).body as string
  return { raw, json: JSON.parse(raw) as SentRequest }
}

describe('egress is exactly the scanned text (REFUTE C1b, round 2)', () => {
  const post = (pdfBytes: Uint8Array, terms = env.CONFIDENTIAL_TERMS) => app().request('/intake/lease',
    body({ filename: 'acme-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u' }),
    { ...env, CONFIDENTIAL_TERMS: terms })

  it('a clean document: the request has only text blocks, page-separated, and never the PDF bytes', async () => {
    const fetchMock = okFetch(); vi.stubGlobal('fetch', fetchMock)
    const pdf = await buildMultiPagePdf(['Commercial lease cover sheet for the premises', 'Base rent schedule and the term of the lease'])
    const res = await post(pdf)
    expect(res.status).toBe(200)
    const { raw, json } = sentBody(fetchMock)
    expect(json.messages[0].content.every(b => b.type === 'text')).toBe(true)
    expect(raw).not.toContain(toBase64(pdf).slice(0, 40))
    expect(raw).not.toMatch(/"document"|application\/pdf|"base64"/)
    expect(raw).toMatch(/--- Page 1 of 2 ---/)
    expect(raw).toContain('Base rent schedule')
  })

  it('(G) an image page with a typed footer now proceeds: only the footer text is sent, with a warning', async () => {
    const fetchMock = okFetch(); vi.stubGlobal('fetch', fetchMock)
    const pdf = await buildImagePlusFooterPdf('CONFIDENTIAL  ORA-000123  Page 3 of 20')
    const res = await post(pdf)
    expect(res.status).toBe(200)
    const { raw } = sentBody(fetchMock)
    expect(raw).toContain('ORA-000123')
    expect(raw).not.toContain(toBase64(pdf).slice(0, 40))
    const json = await res.json() as { warnings: string[] }
    expect(json.warnings.join(' ')).toMatch(/image/i)
  })

  it('(A) a confidential term only in a form-field value still blocks with no egress', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await post(await buildFormFieldPdf('Lease Agreement - Exhibit B - Page 3', 'Zeta Partners'))
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/confidential/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a harmless form field proceeds, and its value is NOT part of the outgoing text', async () => {
    const fetchMock = okFetch(); vi.stubGlobal('fetch', fetchMock)
    const res = await post(await buildFormFieldPdf('Lease Agreement - Exhibit B - Page 3', 'Acme Logistics'))
    expect(res.status).toBe(200)
    expect(sentBody(fetchMock).raw).not.toContain('Acme Logistics')
  })

  it('(probe D) 422 and NO egress for a term split across a page break', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const pdf = await buildMultiPagePdf([
      'This lease is between the Landlord, ZZP',
      'Partnership, and the Tenant named herein below.',
    ])
    const res = await post(pdf, 'zeta,ZZP Partnership')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/confidential/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // intake-probe2.mjs P1-P7: the term is painted in a way pdf.js does not extract. Whatever the
  // gate decides, the term and the raw PDF must never be in an outgoing request.
  it.each(['P1_link_appearance_stream', 'P2_lying_tounicode', 'P3_outlined_text', 'P4_image_in_tiling_pattern', 'P5_image_in_form_xobject', 'P6_type3_glyph_image', 'P7_shading'])(
    'probe %s: the hidden term never leaves, and neither does the PDF', async (name) => {
      const fetchMock = okFetch(); vi.stubGlobal('fetch', fetchMock)
      const pdf = (await buildRefuteProbes('Blueridge Partners'))[name]
      const res = await post(pdf, 'Blueridge Partners')
      expect([200, 422]).toContain(res.status)
      for (const call of fetchMock.mock.calls) {
        const raw = (call[1] as RequestInit).body as string
        expect(raw).not.toMatch(/blueridge/i)
        expect(raw).not.toContain(toBase64(pdf).slice(0, 40))
        expect(raw).toContain(BENIGN_LINE.slice(0, 30))
      }
    })

  it('probe P8: a Link URL carrying the term blocks (URLs are scanned)', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await post(buildLinkUrlTermPdf('https://blueridge-partners.com/x'), 'Blueridge Partners')
    expect(res.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('probe P9: a zero-page PDF blocks with no egress', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await post(buildZeroPagePdf())
    expect(res.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Lease abstraction v2 (mode: 'abstract') — same guards, structured-output egress, deep post-egress scrub.
// ---------------------------------------------------------------------------
describe("mode: 'abstract' (lease abstraction v2)", () => {
  const LEASE_TEXT = 'Industrial lease. Tenant: Acme Logistics LLC. Base rent $4,500.00 per month. Renewal option on notice.'
  const post = (pdfBytes: Uint8Array, extra: object = {}) => app().request('/intake/lease',
    body({ filename: 'acme-lease.pdf', pdfBase64: toBase64(pdfBytes), tenant_id: 't', unit_id: 'u', mode: 'abstract', ...extra }), env)
  // WIRE form (lease-abstract.ts: fact list, zero-or-more lists, 0 / "" sentinels).
  const modelJson = (over: Record<string, unknown> = {}) => ({
    facts: [{ field: 'tenant_legal_name', value: 'Acme Logistics LLC', page: 1, quote: 'Tenant: Acme Logistics LLC', confidence: 0.9 }],
    rent_schedule: [], escalations: [], concessions: [], recurring_charges: [], late_fees: [], provisions: [],
    ...over,
  })
  const abstractFetch = (payload: object, stop = 'end_turn') => vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(payload) }] }),
  })

  it('rejects an unknown mode before any egress', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await post(await buildTextPdf(LEASE_TEXT), { mode: 'full' })
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the PDF content confidentiality scan still blocks with NO egress', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await post(await buildTextPdf('Confidential lease for the Zeta acquisition'))
    expect(res.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an image-only PDF still blocks with NO egress', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const res = await post(await buildImageOnlyPdf())
    expect(res.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('egress is scanned text with structured outputs (no forced tool_choice, no PDF), and returns abstract + flags', async () => {
    const fetchMock = abstractFetch(modelJson()); vi.stubGlobal('fetch', fetchMock)
    const pdf = await buildTextPdf(LEASE_TEXT)
    const res = await post(pdf)
    expect(res.status).toBe(200)
    const { raw } = sentBody(fetchMock)
    const sent = JSON.parse(raw) as { output_config?: { format?: { type?: string } }; tool_choice?: unknown; messages: Array<{ content: Array<{ type: string }> }> }
    expect(sent.output_config?.format?.type).toBe('json_schema')
    expect(sent.tool_choice).toBeUndefined()
    expect(sent.messages[0].content.every((b) => b.type === 'text')).toBe(true)
    expect(raw).not.toContain(toBase64(pdf).slice(0, 40))
    expect(raw).not.toMatch(/application\/pdf|"base64"/)
    const json = await res.json() as { abstract: { tenant_legal_name: { value: string } }; flags: Array<{ severity: string }> }
    expect(json.abstract.tenant_legal_name.value).toBe('Acme Logistics LLC')
    expect(json.flags.some((f) => f.severity === 'block')).toBe(true) // no schedule/dates in this tiny lease
  })

  it('post-egress: any string anywhere in the abstract that hits the denylist is nulled and reported by path', async () => {
    const leak = { category: 'other', summary: 'Tenant is an affiliate of Zeta Partners', notice_deadline: '',
      exercise_window_start: '', exercise_window_end: '', page: 1, quote: 'Renewal option on notice', confidence: 0.5 }
    vi.stubGlobal('fetch', abstractFetch(modelJson({ provisions: [leak] })))
    const res = await post(await buildTextPdf(LEASE_TEXT))
    expect(res.status).toBe(200)
    const json = await res.json() as { abstract: { provisions: Array<{ summary: string | null }> }; warnings: string[] }
    expect(json.abstract.provisions[0].summary).toBeNull()
    expect(JSON.stringify(json)).not.toMatch(/zeta/i)
    expect(json.warnings).toContain('"provisions[0].summary" was withheld by the confidentiality guard.')
  })

  it('a billing value withheld by the guard becomes a blocking flag (the earlier checks never saw the hole)', async () => {
    const cam = { type: 'other', description: 'Zeta escrow', amount_monthly: 4500, effective_start: '2026-01-01', effective_end: '2026-12-31',
      page: 1, quote: 'Base rent $4,500.00 per month', confidence: 0.5 }
    vi.stubGlobal('fetch', abstractFetch(modelJson({ recurring_charges: [cam] })))
    const res = await post(await buildTextPdf(LEASE_TEXT))
    const json = await res.json() as { abstract: { recurring_charges: Array<{ description: string | null }> }; flags: Array<{ severity: string; path: string; message: string }> }
    expect(json.abstract.recurring_charges[0].description).toBeNull()
    expect(json.flags).toContainEqual(expect.objectContaining({ severity: 'block', path: 'recurring_charges[0].description' }))
    expect(JSON.stringify(json)).not.toMatch(/zeta/i)
  })

  // Merge gate PR #69 round 1: F-004 (flag scrub was untested), O-2 (numbers were not scrubbed),
  // F-004/O-1 (withheld-billing-value block was only tested for recurring_charges).
  it('a denylisted NUMBER is withheld from both the abstract and any flag message that echoes it', async () => {
    const row = { start: '2026-01-01', end: '2026-12-31', base_rent_monthly: 4500, rent_psf_annual: 99999,
      page: 1, quote: 'Base rent $4,500.00 per month', confidence: 0.9 }
    // An RSF fact makes the $/SF tie-out flag quote the stated 99999 in its message.
    const facts = [
      { field: 'tenant_legal_name', value: 'Acme Logistics LLC', page: 1, quote: 'Tenant: Acme Logistics LLC', confidence: 0.9 },
      { field: 'premises_rsf', value: '1000', page: 1, quote: 'Industrial lease. Tenant: Acme', confidence: 0.9 },
    ]
    vi.stubGlobal('fetch', abstractFetch(modelJson({ facts, rent_schedule: [row] })))
    const res = await post(await buildTextPdf(LEASE_TEXT))
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toMatch(/99999/)
    const json = JSON.parse(raw) as { abstract: { rent_schedule: Array<{ rent_psf_annual: unknown }> }; warnings: string[] }
    expect(json.abstract.rent_schedule[0].rent_psf_annual).toBeNull()
    expect(json.warnings.some((w) => /^"flags\[\d+\]\.message" was withheld/.test(w))).toBe(true)
  })

  it.each([
    ['rent_schedule', { rent_schedule: [{ start: '2026-01-01', end: '2026-12-31', base_rent_monthly: 4500, rent_psf_annual: 0, page: 1, quote: 'Zeta rent schedule line', confidence: 0.9 }] }, 'rent_schedule[0].quote'],
    ['concessions', { concessions: [{ charge_type: 'rent', period_start: '2026-01-01', period_end: '2026-01-31', kind: 'full_waiver', value: 0, reason: 'Zeta free rent', page: 1, quote: 'Renewal option on notice', confidence: 0.9 }] }, 'concessions[0].reason'],
  ])('a withheld %s value blocks approval', async (_name, over, path) => {
    vi.stubGlobal('fetch', abstractFetch(modelJson(over)))
    const res = await post(await buildTextPdf(LEASE_TEXT))
    const json = await res.json() as { flags: Array<{ severity: string; path: string }> }
    expect(json.flags).toContainEqual(expect.objectContaining({ severity: 'block', path }))
  })

  it('a refusal or truncated output is a 502 manual-entry error, never a partial abstract', async () => {
    vi.stubGlobal('fetch', abstractFetch(modelJson(), 'refusal'))
    expect((await post(await buildTextPdf(LEASE_TEXT))).status).toBe(502)
    vi.stubGlobal('fetch', abstractFetch(modelJson(), 'max_tokens'))
    const res = await post(await buildTextPdf(LEASE_TEXT))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toMatch(/too long/)
  })

  it('omitting mode keeps the original 9-field response shape', async () => {
    vi.stubGlobal('fetch', okFetch())
    const res = await app().request('/intake/lease',
      body({ filename: 'a.pdf', pdfBase64: toBase64(await buildTextPdf(LEASE_TEXT)), tenant_id: 't', unit_id: 'u' }), env)
    expect(res.status).toBe(200)
    expect(Object.keys(await res.json() as object).sort()).toEqual(['confidence', 'fields', 'warnings'])
  })
})
