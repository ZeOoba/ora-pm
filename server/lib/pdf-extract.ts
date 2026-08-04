// server/lib/pdf-extract.ts
//
// Server-side PDF text extraction for the intake confidentiality content
// scan (OI-044). Uses `unpdf` — a serverless-friendly wrapper around pdf.js
// with no native dependencies, verified to run under both the Cloudflare
// Workers runtime and this repo's Vitest (Node) environment.
import { getDocumentProxy, extractText } from 'unpdf'

/**
 * Extracts plain text from PDF bytes, for scanning pre-egress (in addition
 * to, not instead of, the filename-only check).
 *
 * Returns '' in two cases the caller must treat identically — "no text was
 * available to scan":
 *   1. A scanned/image-only PDF with no text layer for pdf.js to find.
 *   2. Malformed/unparseable bytes.
 * This function never throws; intake.ts's caller is the one that decides
 * fail-open-with-warning vs. fail-closed for an empty result (see
 * server/routes/intake.ts) — that policy choice does not belong here.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(bytes)
    const { text } = await extractText(pdf, { mergePages: true })
    return text.trim()
  } catch {
    return ''
  }
}
