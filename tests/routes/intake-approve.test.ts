import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { intakeRouter } from '../../server/routes/intake'
import { buildTextPdf, toBase64 } from '../fixtures/pdf'
import { PAGES, buildLeasePdf, reviewed } from '../fixtures/lease-abstract-approve'
import { confirmationKey, revalidateAbstract } from '../../server/lib/lease-abstract'
import { buildApprovalPayload, BillingDivergenceError } from '../../server/lib/lease-approve'

vi.mock('../../server/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })) }))

const state = {
  uploadError: null as null | { message: string },
  rpcResult: { data: { outcome: 'approved', lease_id: 'L', tenant_id: 'T' } as unknown, error: null as null | { message: string } },
}
const upload = vi.fn(async () => ({ data: {}, error: state.uploadError }))
const rpc = vi.fn(async () => state.rpcResult)
const mockDb = { storage: { from: vi.fn(() => ({ upload })) }, rpc, from: vi.fn() }
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => mockDb) }))

const env = { ANTHROPIC_API_KEY: 'sk-test', CONFIDENTIAL_TERMS: 'zeta', SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }
function app() { const a = new Hono(); a.route('/intake', intakeRouter); return a }
const post = (o: object) => app().request('/intake/lease/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }, env)

const UNIT = '20000000-0000-0000-0000-000000000001'
let pdf: string
async function body(over: Record<string, unknown> = {}) {
  // The PDF carries the lease's own pages: approval re-verifies every quote against it.
  pdf ??= toBase64(await buildLeasePdf())
  const r = reviewed()
  const rv = revalidateAbstract(JSON.parse(JSON.stringify(r.abstract)), PAGES)
  const keys = rv.confirmations.map(confirmationKey)
  let signature: string | null = null
  try {
    buildApprovalPayload(rv.abstract, { unitId: '', today: '2026-11-23', tenant: { mode: 'new', name: 'x' }, replace: null, notes: null, storagePath: '', fileSha256: '', filename: '', model: '', approvedBy: '', warnings: [], acknowledgedDivergence: null })
  } catch (e) { if (e instanceof BillingDivergenceError) signature = e.signature }
  return {
    filename: 'Acme Lease.pdf', pdfBase64: pdf, unit_id: UNIT,
    tenant: { mode: 'new', name: 'Acme Fabrication' }, replace: null,
    abstract: r.abstract, confirmed_keys: keys, acknowledged_divergence: signature, notes: 'Renewal option.',
    ...over,
  }
}

// Every approval parses the PDF (pdf.js); under a loaded machine that can exceed the 5 s default.
vi.setConfig({ testTimeout: 20_000 })
beforeAll(async () => { pdf = toBase64(await buildLeasePdf()) }, 30_000)

beforeEach(() => {
  vi.clearAllMocks()
  state.uploadError = null
  state.rpcResult = { data: { outcome: 'approved', lease_id: 'L', tenant_id: 'T' }, error: null }
})

describe('POST /intake/lease/approve', () => {
  it('stores the PDF content-addressed, calls the RPC with a re-derived payload, returns 201', async () => {
    const res = await post(await body())
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ outcome: 'approved', lease_id: 'L' })
    expect(upload).toHaveBeenCalledTimes(1)
    const [path, , opts] = upload.mock.calls[0] as unknown as [string, Uint8Array, Record<string, unknown>]
    expect(path).toMatch(/^abstracts\/[0-9a-f]{64}\.pdf$/)
    expect(opts).toMatchObject({ contentType: 'application/pdf', upsert: true })
    const p = (rpc.mock.calls[0] as unknown as [string, { p: { lease: Record<string, unknown>; abstract: Record<string, unknown>; tenant: Record<string, unknown> } }])[1].p
    expect(p.lease.base_rent_monthly).toBe(8333.33)
    expect(p.abstract.file_sha256 as string).toBe(path.slice('abstracts/'.length, -4))
    expect(p.tenant.name).toBe('Acme Fabrication')
  })

  it('refuses when any billing value is unconfirmed, before storing anything', async () => {
    const b = await body()
    const res = await post({ ...b, confirmed_keys: (b.confirmed_keys as string[]).slice(1) })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { missing: string[]; flags: unknown[]; error: string }).missing).toHaveLength(1)
    expect(upload).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses an abstract with an open block (tampered as-written amount)', async () => {
    const b = await body()
    const a = JSON.parse(JSON.stringify(b.abstract))
    a.rent_schedule[0].amount_as_written = '$1.00'
    const res = await post({ ...b, abstract: a })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { missing: string[]; flags: unknown[]; error: string }).flags.length).toBeGreaterThan(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps an occupied unit to 409 with guidance', async () => {
    state.rpcResult = { data: { outcome: 'unit_occupied', lease_id: 'OLD' }, error: null }
    const res = await post(await body())
    expect(res.status).toBe(409)
    expect(((await res.json()) as { missing: string[]; flags: unknown[]; error: string }).error).toMatch(/Replace that tenant/)
  })

  it('returns 200 for an already-approved file (idempotent)', async () => {
    state.rpcResult = { data: { outcome: 'already_approved', lease_id: 'L' }, error: null }
    expect((await post(await body())).status).toBe(200)
  })

  it('a storage failure saves nothing', async () => {
    state.uploadError = { message: 'boom' }
    const res = await post(await body())
    expect(res.status).toBe(502)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-PDF and a malformed body', async () => {
    expect((await post(await body({ pdfBase64: 'aGVsbG8=' }))).status).toBe(415)
    expect((await post(await body({ unit_id: 'nope' }))).status).toBe(400)
    expect((await post(await body({ tenant: { mode: 'new', name: '  ' } }))).status).toBe(400)
  })
  it('REFUTE C1b: a tick on a value that later changed does not count (keys are content, not path)', async () => {
    const b = await body()
    const a = JSON.parse(JSON.stringify(b.abstract))
    a.recurring_charges[0].amount_as_written = '$1,300.00'
    a.recurring_charges[0].quote = '$1,300.00 [entered by reviewer]'
    const res = await post({ ...b, abstract: a })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { missing: string[] }).missing).toContain('recurring_charges[0]')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('REFUTE C1c: the abstract is verified against the uploaded PDF, not any PDF', async () => {
    const other = toBase64(await buildTextPdf('An unrelated document with enough text to carry a text layer.'))
    const res = await post(await body({ pdfBase64: other }))
    expect(res.status).toBe(422)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('REFUTE C4: refuses until the under-billing months are acknowledged with their exact signature', async () => {
    const res = await post(await body({ acknowledged_divergence: null }))
    expect(res.status).toBe(422)
    const j = (await res.json()) as { divergence: { under: Array<{ period: string }>; over: unknown[]; signature: string } }
    expect(j.divergence.under.map((d) => d.period)).toContain('2027-01')
    expect(j.divergence.over).toEqual([])
    expect((await post(await body({ acknowledged_divergence: 'stale' }))).status).toBe(422)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('REFUTE round 2 C4: an over-billed month (abatement) is refused even when acknowledged', async () => {
    const r = reviewed({ abatement: true })
    const rv = revalidateAbstract(JSON.parse(JSON.stringify(r.abstract)), PAGES)
    const res = await post(await body({ abstract: r.abstract, confirmed_keys: rv.confirmations.map(confirmationKey), acknowledged_divergence: 'anything' }))
    expect(res.status).toBe(422)
    const j = (await res.json()) as { error: string; divergence: { over: Array<{ period: string }> } }
    expect(j.error).toMatch(/charge MORE/)
    expect(j.divergence.over.map((d) => d.period)).toContain('2026-01')
    expect(rpc).not.toHaveBeenCalled()
  })
})
