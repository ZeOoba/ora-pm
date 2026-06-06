import { Hono } from 'hono'
import type { Env } from '../index'
import { parseTerms, containsConfidentialTerm } from '../lib/confidentiality'
import { extractLease } from '../lib/lease-extract'

export const intakeRouter = new Hono<{ Bindings: Env }>()

const DEFAULT_MODEL = 'claude-opus-4-8'
const MAX_PDF_BYTES = 10 * 1024 * 1024 // mirror the client cap; the client check is bypassable

intakeRouter.post('/lease', async (c) => {
  const { filename, pdfBase64, tenant_id, unit_id } = await c.req.json().catch(() => ({}))
  if (!filename || !pdfBase64 || !tenant_id || !unit_id) {
    return c.json({ error: 'filename, pdfBase64, tenant_id, unit_id are required' }, 400)
  }

  // Confidentiality guard. NOTE (Phase 2a scope): this scans the FILENAME only, not the decoded PDF
  // CONTENT — full server-side PDF text extraction is deferred to Phase 2b (the Cloudflare Worker
  // runtime has no clean PDF parser). Defense-in-depth meanwhile: (1) fail-closed when the denylist
  // is unconfigured (below); (2) the route is admin-gated; (3) it is structurally limited to an
  // existing managed tenant_id+unit_id, so by construction it is a managed-portfolio lease, never a
  // confidential acquisition; (4) the upload UI carries an explicit attestation.
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

  let result
  try {
    const model = c.env.INTAKE_MODEL ?? DEFAULT_MODEL
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
