// server/lib/pdf-extract.ts
//
// Server-side PDF text extraction for the intake confidentiality content
// scan (OI-044). Uses `unpdf` — a serverless-friendly wrapper around pdf.js
// with no native dependencies, verified to run under both the Cloudflare
// Workers runtime and this repo's Vitest (Node) environment.
import { getDocumentProxy, extractText } from 'unpdf'

/**
 * Minimum NON-whitespace characters a page's text layer must carry for the
 * intake content scan to count that page as scanned.
 *
 * Why per page (audit finding intake-partial-text-layer-egress): the scan used
 * to pass as soon as the merged document text was non-empty, so a typed cover
 * page in front of scanned, image-only lease pages cleared the scan on the
 * cover alone and the whole PDF, image pages included, egressed to
 * api.anthropic.com. Every page must now clear this bar or intake fails closed.
 *
 * Why 25: an image-only page yields 0 characters; the residue a scanner or
 * Bates stamper leaves on an otherwise image-only page ("Page 3 of 20" = 9,
 * "ABC-000123" = 10) stays well under it; a genuine text page of a lease, even a
 * sparse signature or exhibit page, carries far more than 25. A false positive
 * (a deliberately blank page in a text PDF) only costs the manual-entry
 * fallback, which is the correct failure direction for a pre-egress gate.
 */
export const MIN_PAGE_TEXT_CHARS = 25

/**
 * Extracts plain text from PDF bytes, merged across pages.
 *
 * Returns '' in two cases the caller must treat identically — "no text was
 * available to scan":
 *   1. A scanned/image-only PDF with no text layer for pdf.js to find.
 *   2. Malformed/unparseable bytes.
 * This function never throws. The intake route uses extractPdfPages (below)
 * so it can gate on every page, not just on the merged total.
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

/**
 * Extracts each page's text separately, in page order. Returns null (never
 * throws) for malformed/unparseable bytes, so the caller can fail closed.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[] | null> {
  try {
    const pdf = await getDocumentProxy(bytes)
    const { text } = await extractText(pdf, { mergePages: false })
    return text
  } catch {
    return null
  }
}

/**
 * 1-based page numbers whose text layer is below MIN_PAGE_TEXT_CHARS
 * non-whitespace characters. An empty page list returns [0] so a zero-page
 * document can never read as "every page passed".
 */
export function pagesLackingTextLayer(pages: readonly string[]): number[] {
  if (pages.length === 0) return [0]
  const lacking: number[] = []
  pages.forEach((page, i) => {
    if (page.replace(/\s/g, '').length < MIN_PAGE_TEXT_CHARS) lacking.push(i + 1)
  })
  return lacking
}
