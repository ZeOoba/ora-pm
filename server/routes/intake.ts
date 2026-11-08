import { Hono } from 'hono'
import type { Env } from '../index'
import { parseTerms, containsConfidentialTerm } from '../lib/confidentiality'
import { extractLease } from '../lib/lease-extract'
import { extractPdfPages, pagesLackingTextLayer, MIN_PAGE_TEXT_CHARS } from '../lib/pdf-extract'
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

  const { filename, pdfBase64, tenant_id, unit_id } = await c.req.json().catch(() => ({}))
  if (!filename || !pdfBase64 || !tenant_id || !unit_id) {
    return c.json({ error: 'filename, pdfBase64, tenant_id, unit_id are required' }, 400)
  }

  // OI-044 tightening: tenant_id/unit_id were previously only checked for
  // PRESENCE, not existence — the compensating-control argument below ("by
  // construction a managed-portfolio lease") only holds if the ids actually
  // resolve to real rows. Existence-check both, before any egress.
  const db = getDb(c.env)
  const { data: tenantRow, error: tenantErr } = await db.from('tenants').select('id').eq('id', tenant_id).maybeSingle()
  if (tenantErr) return c.json({ error: 'Failed to verify tenant' }, 500)
  if (!tenantRow) return c.json({ error: 'Tenant not found' }, 404)
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
  const pages = await safeDecodeAndExtractPages(pdfBase64)
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
  // Pages joined with a newline: a term split across a page break still matches (whitespace runs
  // are collapsed by containsConfidentialTerm's normalization).
  if (containsConfidentialTerm(pages!.join('\n'), terms)) {
    return c.json({ error: 'Blocked: document appears to reference a confidential matter.' }, 422)
  }

  let result
  try {
    const model = resolveModel(c.env.INTAKE_MODEL)
    result = await extractLease(pdfBase64, { apiKey: c.env.ANTHROPIC_API_KEY, model })
  } catch {
    return c.json({ error: 'Lease extraction failed. Enter the lease manually.' }, 502)
  }

  // Post-egress defense: scrub any field whose text hits the denylist.
  const warnings = [...result.warnings]
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

/** Decodes the base64 payload and extracts per-page text. Never throws — a
 *  decode failure (shouldn't happen once the magic-byte check above has
 *  passed, but is not impossible for a crafted payload) or an unparseable PDF
 *  returns null, which the call site treats as "no text available" and blocks. */
async function safeDecodeAndExtractPages(pdfBase64: string): Promise<string[] | null> {
  try {
    const bytes = Uint8Array.from(atob(pdfBase64), (ch) => ch.charCodeAt(0))
    return await extractPdfPages(bytes)
  } catch {
    return null
  }
}
