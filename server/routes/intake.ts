import { Hono } from 'hono'
import type { Env } from '../index'
import { parseTerms, containsConfidentialTerm } from '../lib/confidentiality'
import { extractLease } from '../lib/lease-extract'
import { z } from 'zod'
import { BILLING_PATH, confirmationKey, extractAbstract, ExtractionStopped, revalidateAbstract, type AbstractFlag, type AbstractResult, type Confirmation } from '../lib/lease-abstract'
import { buildApprovalPayload, ApprovalInputError, BillingDivergenceError, OverBillingError, type BillingDivergence } from '../lib/lease-approve'
import { todayUtc } from '../lib/collections'
import { inspectPdf, pagesLackingTextLayer, MIN_PAGE_TEXT_CHARS, type PdfInspection } from '../lib/pdf-extract'
import { checkRateLimit } from '../lib/rate-limit'
import { ANTHROPIC_MODEL } from '../lib/models'
import { getDb } from '../db/client'

export const intakeRouter = new Hono<{ Bindings: Env }>()

const DEFAULT_MODEL = ANTHROPIC_MODEL
const MAX_PDF_BYTES = 10 * 1024 * 1024 // mirror the client cap; the client check is bypassable

// OI-038 remainder: this is an LLM-spend-specific budget (each request egresses
// a document to api.anthropic.com), independent of and tighter than the
// generic 120/min admin-mutation limit server/index.ts applies to every
// admin-gated mutation route (this one included) — both buckets apply here.
const INTAKE_RATE_LIMIT = { scope: 'intake', maxCalls: 10, windowMs: 24 * 60 * 60 * 1000 } // 10/day per admin

// OI-038 remainder, item 3: INTAKE_MODEL was previously an unconstrained env
// override — any value an operator (or a compromised/misconfigured env) set
// went straight into the Anthropic request. Constrained to an allowlist
// (smaller diff than removing the override outright, and the override is a
// real, documented ops escape hatch — see README's "INTAKE_MODEL" env var
// and architecture diagram — for swapping models without a redeploy, e.g.
// around a model deprecation). A non-allowlisted value silently falls back
// to DEFAULT_MODEL rather than rejecting the request — the operator's intent
// was "use my override", not "block lease intake"; the resulting request
// still runs, just against a known-good model. Update this list when a new
// model id is approved for lease-intake use.
const ALLOWED_MODELS = new Set<string>([ANTHROPIC_MODEL, 'claude-sonnet-5'])

function resolveModel(requested: string | undefined): string {
  return requested && ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL
}

intakeRouter.post('/lease', async (c) => {
  // Rate limit first — cheap, and keyed off the authenticated admin (set by
  // server/index.ts's adminAuthMiddleware, which gates this route), not
  // request-body content. Falls back to CF-Connecting-IP then a fixed key
  // only when adminUserId isn't set (e.g. this router mounted standalone in
  // a test, bypassing the real admin-auth middleware chain).
  const adminUserId = c.get('adminUserId') ?? c.req.header('CF-Connecting-IP') ?? 'unknown-admin'
  const { allowed, retryAfterMs } = await checkRateLimit(c.env.RATE_LIMIT_KV, adminUserId, INTAKE_RATE_LIMIT)
  if (!allowed) {
    return c.json({ error: `Too many lease-intake requests — retry in ${Math.ceil(retryAfterMs / 1000)}s` }, 429)
  }

  const { filename, pdfBase64, tenant_id, unit_id, mode } = await c.req.json().catch(() => ({}))
  // 'abstract' = lease abstraction v2 (server/lib/lease-abstract.ts): the full abstract with citations
  // and cross-check flags. Absent = the original 9-field extraction, unchanged. Every guard below runs
  // identically for both modes; only the extractor and the post-egress scrub differ.
  if (mode !== undefined && mode !== 'abstract') {
    return c.json({ error: "mode must be 'abstract' or omitted" }, 400)
  }
  // Phase 4: an abstract may be for a NEW tenant that has no row yet (it is created at approval), so
  // tenant_id is optional in abstract mode. unit_id stays required and existence-checked: it is what binds
  // the document to the managed portfolio (the OI-044 compensating control below).
  if (!filename || !pdfBase64 || !unit_id || (!tenant_id && mode !== 'abstract')) {
    return c.json({ error: mode === 'abstract' ? 'filename, pdfBase64, unit_id are required' : 'filename, pdfBase64, tenant_id, unit_id are required' }, 400)
  }

  // OI-044 tightening: tenant_id/unit_id were previously only checked for
  // PRESENCE, not existence — the compensating-control argument below ("by
  // construction a managed-portfolio lease") only holds if the ids actually
  // resolve to real rows. Existence-check both, before any egress.
  const db = getDb(c.env)
  if (tenant_id) {
    const { data: tenantRow, error: tenantErr } = await db.from('tenants').select('id').eq('id', tenant_id).maybeSingle()
    if (tenantErr) return c.json({ error: 'Failed to verify tenant' }, 500)
    if (!tenantRow) return c.json({ error: 'Tenant not found' }, 404)
  }
  const { data: unitRow, error: unitErr } = await db.from('units').select('id').eq('id', unit_id).maybeSingle()
  if (unitErr) return c.json({ error: 'Failed to verify unit' }, 500)
  if (!unitRow) return c.json({ error: 'Unit not found' }, 404)

  // Confidentiality guard — filename check. NOTE: this used to be the ONLY content check (scanned the
  // FILENAME only, never the decoded PDF content) — see the extracted-text scan further down for the
  // OI-044 fix. Defense-in-depth kept regardless: (1) fail-closed when the denylist is unconfigured
  // (below); (2) the route is admin-gated; (3) tenant_id+unit_id are now existence-checked, not just
  // presence-checked, against the managed portfolio; (4) the upload UI carries an explicit attestation.
  const terms = parseTerms(c.env.CONFIDENTIAL_TERMS)
  if (terms.length === 0) {
    // Fail-CLOSED: never egress a document to the external API with no confidentiality denylist set.
    return c.json({ error: 'Lease intake is disabled: the confidentiality guard is not configured.' }, 503)
  }
  if (containsConfidentialTerm(filename, terms)) {
    return c.json({ error: 'Blocked: document appears to reference a confidential matter.' }, 422)
  }

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: 'Lease extraction is not configured (no API key).' }, 501)
  }

  // Server-side input validation (the client-side checks in file-drop.ts are bypassable by a direct
  // API caller). Reject oversized payloads and anything that is not actually a PDF before egress.
  if (Math.floor((pdfBase64.length * 3) / 4) > MAX_PDF_BYTES) {
    return c.json({ error: 'File too large (max 10 MB).' }, 413)
  }
  if (!pdfBase64.startsWith('JVBER')) { // base64 of the "%PDF" magic bytes
    return c.json({ error: 'Uploaded file is not a valid PDF.' }, 415)
  }

  // OI-044: PDF CONTENT scan, pre-egress. The filename check above never saw the actual document
  // text — a confidential-matter lease saved as an innocuous filename would have egressed in full.
  // Extract the text and run it through the same denylist. On a match, block with the same 422 the
  // filename check uses, and — this is the load-bearing property — WITHOUT ever calling extractLease
  // (no egress to api.anthropic.com happens for a blocked document).
  //
  // Per-page gate (audit finding intake-partial-text-layer-egress): this used to accept any
  // non-empty MERGED text, so a typed cover page in front of scanned, image-only pages cleared the
  // scan on the cover alone while the whole PDF (image pages included) egressed. Every page must now
  // carry a text layer of at least MIN_PAGE_TEXT_CHARS non-whitespace characters (rationale for the
  // threshold: server/lib/pdf-extract.ts), or the request fails closed with no egress.
  //
  // REFUTE C1b (rounds 1-2): a PDF can paint content pdf.js never extracts: raster images (a
  // scanned page behind a typed footer), AcroForm / annotation appearances (including a Link /AP
  // stream), a lying ToUnicode map, outlined or Type3 glyphs, images inside patterns. Detecting
  // every such construct is not tractable, so the fix changes WHAT LEAVES instead: extractLease
  // receives the scanned per-page text (inspection.pages) and never the raw PDF bytes, so the
  // outgoing request is exactly the text this scan cleared. Consequently:
  //   1. the term scan covers page text AND every annotation/form-field string (inspectPdf) — the
  //      latter is not in the outgoing text, but a term there still marks a confidential matter;
  //   2. images, form fields and annotations no longer block (they are simply not sent); a warning
  //      tells the user which pages carried content the extraction did not see;
  //   3. the per-page MIN_PAGE_TEXT_CHARS rule stays: a scanned page has no text to send, and a
  //      lease missing pages would extract wrong terms, so it still blocks.
  const inspection = await safeDecodeAndInspect(pdfBase64)
  const pages = inspection?.pages ?? null
  // Pages joined with a newline: a term split across a page break still matches (whitespace runs
  // are collapsed by containsConfidentialTerm's normalization). Annotation/field text included.
  if (inspection && containsConfidentialTerm([...inspection.pages, inspection.annotationText].join('\n'), terms)) {
    return c.json({ error: 'Blocked: document appears to reference a confidential matter.' }, 422)
  }
  const lacking = pages ? pagesLackingTextLayer(pages) : [0]
  if (lacking.length > 0) {
    // REFUTE-pass correction (2026-08-03): an image-only/scanned PDF has no text
    // layer for pdf.js to find, so the content scan cannot run. This used to fail
    // OPEN (proceed with a warning attached to the response) — but extraction ran,
    // and the document egressed to api.anthropic.com, BEFORE that warning was ever
    // surfaced, for an admin-authenticated request that may be a real confidential
    // deal's scanned lease. None of the other controls on this route substitute for
    // a content check that didn't run: admin-gating and the tenant/unit existence
    // check are orthogonal to confidentiality (a real confidential deal's tenant/
    // unit legitimately exist), and the upload-UI attestation is not enforced
    // server-side. Block instead, matching the manual-entry fallback this route
    // already uses for extraction failures below — never egress a document this
    // scan couldn't clear. The same now applies to a document where only SOME
    // pages lack a text layer.
    const where = !pages || lacking[0] === 0
      ? 'no extractable text'
      : `page(s) ${lacking.join(', ')} of ${pages.length} have no usable text layer (fewer than ${MIN_PAGE_TEXT_CHARS} characters)`
    return c.json({
      error: `Content scan unavailable for this document (image-based/scanned PDF: ${where}). `
        + 'Enter this lease manually, or convert it to a fully text-based PDF and re-upload.',
    }, 422)
  }
  const scanned = inspection!

  if (mode === 'abstract') {
    let abs: AbstractResult
    try {
      // Scanned text only — never pdfBase64 (see the REFUTE C1b comment above).
      abs = await extractAbstract(scanned.pages, { apiKey: c.env.ANTHROPIC_API_KEY, model: resolveModel(c.env.INTAKE_MODEL) })
    } catch (e) {
      const msg = e instanceof ExtractionStopped && e.reason === 'max_tokens'
        ? 'The lease was too long to abstract in one pass. Enter it manually.'
        : 'Lease abstraction failed. Enter the lease manually.'
      return c.json({ error: msg }, 502)
    }
    const warnings = [...abs.warnings]
    const notSent = describeNotSent(scanned)
    if (notSent) {
      warnings.push(`Only the document's extracted text was sent for extraction; ${notSent} were not. Check the extracted fields against the document.`)
    }
    // Post-egress defense, deep: every string anywhere in the abstract (values, quotes, summaries,
    // reasons, descriptions) is checked; a hit nulls that string and is reported by path.
    const scrubbed: string[] = []
    const abstract = scrubConfidential(abs.abstract, terms, '', scrubbed)
    // Flag MESSAGES are scrubbed (they echo amounts, dates and figures from the lease). Only the message:
    // severity and path are fixed server values, and scrubbing them let a term like "lock" null the
    // severity of every block flag, which fails open (merge gate R2-08).
    const flags: AbstractFlag[] = abs.flags.map((f, i) => ({
      ...f,
      message: scrubConfidential(f.message, terms, `flags[${i}].message`, scrubbed) ?? 'Withheld by the confidentiality guard.',
    }))
    const confirmations = scrubConfirmations(abs.confirmations, terms, scrubbed, flags)
    // A withheld value on a billing path leaves a hole the earlier checks never saw, so it blocks
    // approval until re-entered by hand.
    for (const w of scrubbed) {
      const path = /^"([^"]+)"/.exec(w)?.[1] ?? ''
      // Same list as the citation-block rule (lease-abstract.ts BILLING_PATH), never a hand copy.
      if (BILLING_PATH.test(path)) {
        flags.push({ severity: 'block', path, message: 'A billing value was withheld by the confidentiality guard; enter it manually.' })
      }
    }
    return c.json({ abstract, flags, confirmations, warnings: [...warnings, ...scrubbed], model: resolveModel(c.env.INTAKE_MODEL) })
  }

  let result
  try {
    const model = resolveModel(c.env.INTAKE_MODEL)
    // Scanned text only — never pdfBase64 (see the REFUTE C1b comment above).
    result = await extractLease(scanned.pages, { apiKey: c.env.ANTHROPIC_API_KEY, model })
  } catch {
    return c.json({ error: 'Lease extraction failed. Enter the lease manually.' }, 502)
  }

  // Post-egress defense: scrub any field whose text hits the denylist.
  const warnings = [...result.warnings]
  const notSent = describeNotSent(scanned)
  if (notSent) {
    warnings.push(`Only the document's extracted text was sent for extraction; ${notSent} were not. Check the extracted fields against the document.`)
  }
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(result.fields)) {
    if (typeof v === 'string' && containsConfidentialTerm(v, terms)) {
      warnings.push(`Field "${k}" was withheld by the confidentiality guard.`)
      continue
    }
    fields[k] = v
  }
  return c.json({ fields, confidence: result.confidence, warnings })
})

// ── Phase 4: approve a reviewed abstract into the PM records ─────────────────
//
// No egress happens here (nothing is sent to the model), so the LLM rate limit and the confidentiality
// pre-scan do not apply; the route is admin-gated like every /api/intake path (server/index.ts).
// NOTHING the client sends is trusted as computed: the abstract is re-validated and every monthly figure
// re-derived from its as-written text (revalidateAbstract), any open 'block' flag refuses approval, and
// every billing value must be in confirmed_paths (plan §5b: a human confirms each one against its quote).
const ApproveBody = z.object({
  filename: z.string().min(1).max(255),
  pdfBase64: z.string().min(1),
  unit_id: z.string().uuid(),
  tenant: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('new'), name: z.string().trim().min(1).max(200),
      contact_name: z.string().max(200).nullish(), contact_email: z.string().max(200).nullish(),
      contact_phone: z.string().max(50).nullish(), notes: z.string().max(5000).nullish(),
    }),
    z.object({ mode: z.literal('existing'), id: z.string().uuid() }),
  ]),
  replace: z.object({ lease_id: z.string().uuid(), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable(),
  abstract: z.unknown(),
  confirmed_keys: z.array(z.string().max(5000)).max(500),
  acknowledged_divergence: z.string().max(20000).nullable().default(null),
  notes: z.string().max(20000).nullable(),
  model: z.string().max(100).optional(),
})

const APPROVE_OUTCOME_STATUS: Record<string, { status: 404 | 409 | 422; error: string }> = {
  unit_not_found: { status: 404, error: 'Unit not found.' },
  tenant_not_found: { status: 404, error: 'Tenant not found.' },
  replace_not_found: { status: 404, error: 'The lease to replace was not found.' },
  replace_wrong_unit: { status: 422, error: 'The lease to replace is on a different unit.' },
  replace_not_active: { status: 409, error: 'The lease to replace is no longer active or pending.' },
  replace_historic: { status: 422, error: 'A lease that has already ended cannot replace the current tenant. Untick replace to record it as history.' },
  replace_bad_end_date: { status: 422, error: "The prior tenant's end date must be on or after its lease start and before the new lease starts." },
  unit_occupied: { status: 409, error: 'Another active or pending lease on this unit overlaps this term. Replace that tenant, or correct the dates.' },
}

// Decode + inspect an approval/recheck PDF. Its page text is what every quote is re-verified against, so
// the abstract is tied to the exact file being stored (REFUTE C1c). Every page must carry a text layer,
// the same rule extraction applies.
async function approvalPages(pdfBase64: unknown): Promise<{ bytes: Uint8Array<ArrayBuffer>; pages: string[] } | { error: string; status: 413 | 415 | 422 }> {
  if (typeof pdfBase64 !== 'string' || !pdfBase64) return { error: 'pdfBase64 is required.', status: 422 }
  if (Math.floor((pdfBase64.length * 3) / 4) > MAX_PDF_BYTES) return { error: 'File too large (max 10 MB).', status: 413 }
  if (!pdfBase64.startsWith('JVBER')) return { error: 'Uploaded file is not a valid PDF.', status: 415 }
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(pdfBase64), (ch) => ch.charCodeAt(0))
  } catch {
    return { error: 'Uploaded file is not a valid PDF.', status: 415 }
  }
  const inspection = await safeDecodeAndInspect(pdfBase64)
  if (!inspection || pagesLackingTextLayer(inspection.pages).length > 0) {
    return { error: 'The PDF has pages without a usable text layer; its quotes cannot be verified.', status: 422 }
  }
  return { bytes, pages: inspection.pages }
}

/** Months where today's flat billing differs from the lease, previewed for the review screen: over-bills
 *  (refused) and under-bills (acknowledgeable, bound to `signature`). */
function previewDivergence(a: Parameters<typeof buildApprovalPayload>[0]): { over: BillingDivergence[]; under: BillingDivergence[]; signature: string | null } {
  try {
    buildApprovalPayload(a, {
      unitId: '', today: todayUtc(), tenant: { mode: 'new', name: 'preview' }, replace: null, notes: null, storagePath: '',
      fileSha256: '', filename: '', model: '', approvedBy: '', warnings: [], acknowledgedDivergence: null,
    })
    return { over: [], under: [], signature: null }
  } catch (e) {
    if (e instanceof OverBillingError) return { over: e.months, under: [], signature: null }
    if (e instanceof BillingDivergenceError) return { over: [], under: e.months, signature: e.signature }
    return { over: [], under: [], signature: null }
  }
}

// Re-run the approval checks on a reviewer-edited abstract without saving anything (no egress, no
// writes): the review screen calls this on open and after edits so flags, confirmations and billing
// divergence match exactly what approval will enforce.
intakeRouter.post('/lease/recheck', async (c) => {
  const body = await c.req.json().catch(() => null) as { abstract?: unknown; pdfBase64?: unknown } | null
  if (!body || body.abstract === undefined) return c.json({ error: 'abstract is required' }, 400)
  const pdf = await approvalPages(body.pdfBase64)
  if ('error' in pdf) return c.json({ error: pdf.error }, pdf.status)
  const rv = revalidateAbstract(body.abstract, pdf.pages)
  return c.json({ abstract: rv.abstract, flags: rv.flags, confirmations: rv.confirmations, warnings: rv.warnings, divergence: previewDivergence(rv.abstract) })
})

intakeRouter.post('/lease/approve', async (c) => {
  const parsed = ApproveBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid approval request.', fields: parsed.error.issues.map((i) => `${i.path.join('.')} (${i.code})`) }, 400)
  const b = parsed.data

  const pdf = await approvalPages(b.pdfBase64)
  if ('error' in pdf) return c.json({ error: pdf.error }, pdf.status)

  const rv = revalidateAbstract(b.abstract, pdf.pages)
  if (rv.warnings.length > 0) return c.json({ error: 'Some reviewed fields are malformed; correct them and approve again.', warnings: rv.warnings }, 422)
  const blocks = rv.flags.filter((f) => f.severity === 'block')
  if (blocks.length > 0) return c.json({ error: 'Resolve every blocking issue before approving.', flags: blocks }, 422)
  // Matched by CONTENT, not path: a value changed after it was ticked is not confirmed (REFUTE C1b).
  const confirmed = new Set(b.confirmed_keys)
  const missing = rv.confirmations.filter((cf) => !confirmed.has(confirmationKey(cf))).map((cf) => cf.path)
  if (missing.length > 0) return c.json({ error: 'Confirm every billing value against the lease before approving.', missing }, 422)

  const sha = await sha256Hex(pdf.bytes)
  const storagePath = `abstracts/${sha}.pdf`
  let payload: Record<string, unknown>
  try {
    payload = buildApprovalPayload(rv.abstract, {
      unitId: b.unit_id,
      today: todayUtc(),
      tenant: b.tenant,
      replace: b.replace,
      notes: b.notes,
      storagePath,
      fileSha256: sha,
      filename: b.filename,
      model: b.model && ALLOWED_MODELS.has(b.model) ? b.model : resolveModel(c.env.INTAKE_MODEL),
      approvedBy: c.get('adminEmail') ?? c.get('adminUserId') ?? 'admin',
      warnings: rv.flags.filter((f) => f.severity === 'warn').map((f) => `${f.path}: ${f.message}`),
      acknowledgedDivergence: b.acknowledged_divergence,
    })
  } catch (e) {
    if (e instanceof OverBillingError) return c.json({ error: e.reason, divergence: { over: e.months, under: [], signature: null } }, 422)
    if (e instanceof BillingDivergenceError) return c.json({ error: e.reason, divergence: { over: [], under: e.months, signature: e.signature } }, 422)
    if (e instanceof ApprovalInputError) return c.json({ error: e.reason }, 422)
    throw e
  }

  const db = getDb(c.env)
  // Content-addressed: re-approving the same bytes overwrites an identical object. Uploaded before the
  // RPC so the lease_documents row never points at a missing object; a refused approval can leave an
  // unreferenced copy behind, never a database row.
  const { error: upErr } = await db.storage.from('lease-documents').upload(storagePath, pdf.bytes, { contentType: 'application/pdf', upsert: true })
  if (upErr) return c.json({ error: 'Failed to store the lease PDF; no records were saved.' }, 502)

  const { data, error } = await db.rpc('approve_lease_abstract', { p: payload })
  if (error) return c.json({ error: 'Approval failed; no records were saved.' }, 500)
  const r = (data ?? {}) as Record<string, unknown>
  const outcome = String(r.outcome ?? '')
  if (outcome === 'approved' || outcome === 'already_approved') return c.json(r, outcome === 'approved' ? 201 : 200)
  const mapped = APPROVE_OUTCOME_STATUS[outcome]
  if (mapped) return c.json({ ...r, error: mapped.error }, mapped.status)
  return c.json({ error: 'Approval failed; no records were saved.' }, 500)
})

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Phase 4 confirmation list scrub. Every field is scrubbed EXCEPT the three fixed labels: path (a schema
 * path), period and charge (closed enums or server labels such as "date"). Nulling a label, as a term
 * like "schedule" did to path (merge gate R3-06), would orphan the entry; every other field, page and
 * cadence included, can carry a model-supplied number and is scrubbed (merge gate R4-03/R4-04). A
 * withheld field adds a block on the billing value the entry belongs to.
 */
export function scrubConfirmations(list: readonly Confirmation[], terms: string[], scrubbed: string[], flags: AbstractFlag[]): Confirmation[] {
  const LABEL_FIELDS: ReadonlySet<string> = new Set(['path', 'period', 'charge'])
  return list.map((cf, i) => {
    const out = { ...cf }
    for (const k of Object.keys(cf) as Array<keyof Confirmation>) {
      if (LABEL_FIELDS.has(k)) continue
      const before = scrubbed.length
      ;(out as Record<string, unknown>)[k] = scrubConfidential(cf[k], terms, `confirmations[${i}].${k}`, scrubbed)
      if (scrubbed.length > before) {
        flags.push({ severity: 'block', path: cf.path, message: "A value in this item's confirmation was withheld by the confidentiality guard; enter it manually." })
      }
    }
    return out
  })
}

/**
 * Deep copy of `v` with every string — and every number, as written — that hits the denylist replaced by
 * null (path reported). Numbers are included because a denylist may hold numeric terms (deal numbers,
 * account numbers) and a number field is otherwise the one place such a term could come back (merge gate O-2).
 */
export function scrubConfidential<T>(v: T, terms: string[], path: string, warnings: string[]): T {
  if (typeof v === 'string' || typeof v === 'number') {
    if (containsConfidentialTerm(String(v), terms)) {
      warnings.push(`"${path}" was withheld by the confidentiality guard.`)
      return null as T
    }
    return v
  }
  if (Array.isArray(v)) return v.map((x, i) => scrubConfidential(x, terms, `${path}[${i}]`, warnings)) as T
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubConfidential(x, terms, path ? `${path}.${k}` : k, warnings)]),
    ) as T
  }
  return v
}

/** Human-readable list of page content that was NOT sent for extraction (images, form fields,
 *  annotations), or null if none. Informational only: nothing here blocks. */
function describeNotSent(i: PdfInspection): string | null {
  const parts: string[] = []
  if (i.imagePages.length > 0) parts.push(`embedded images on page(s) ${i.imagePages.join(', ')}`)
  if (i.annotationPages.length > 0) parts.push(`form fields or annotations on page(s) ${i.annotationPages.join(', ')}`)
  else if (i.hasAcroForm) parts.push('form fields')
  return parts.length > 0 ? parts.join(' and ') : null
}

/** Decodes the base64 payload and inspects the PDF (per-page text, images, annotations, form
 *  fields). Never throws — a decode failure (shouldn't happen once the magic-byte check above has
 *  passed, but is not impossible for a crafted payload) or an unparseable PDF returns null, which
 *  the call site treats as "no text available" and blocks. */
async function safeDecodeAndInspect(pdfBase64: string): Promise<PdfInspection | null> {
  try {
    const bytes = Uint8Array.from(atob(pdfBase64), (ch) => ch.charCodeAt(0))
    return await inspectPdf(bytes)
  } catch {
    return null
  }
}
