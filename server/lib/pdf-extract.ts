// server/lib/pdf-extract.ts
//
// Server-side PDF text extraction for the intake confidentiality content
// scan (OI-044). Uses `unpdf` — a serverless-friendly wrapper around pdf.js
// with no native dependencies, verified to run under both the Cloudflare
// Workers runtime and this repo's Vitest (Node) environment.
import { getDocumentProxy, extractText, getResolvedPDFJS } from 'unpdf'

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

// pdf.js OPS codes for every operator that paints raster image data (from pdf.js's OPS table,
// resolved at runtime below; these names are the stable API).
const IMAGE_OP_NAMES = [
  'paintImageXObject',
  'paintImageXObjectRepeat',
  'paintInlineImageXObject',
  'paintInlineImageXObjectGroup',
  'paintImageMaskXObject',
  'paintImageMaskXObjectGroup',
  'paintImageMaskXObjectRepeat',
  'paintSolidColorImageMask',
] as const

export interface PdfInspection {
  /** Per-page text from getTextContent, in page order. */
  pages: string[]
  /** 1-based pages whose content stream paints any raster image (scan, logo, signature image). */
  imagePages: number[]
  /** 1-based pages carrying any annotation other than a plain hyperlink (form widgets, comments,
   *  stamps, free text...): their rendered content is not part of getTextContent. */
  annotationPages: number[]
  /** True when the document has an AcroForm with at least one field. */
  hasAcroForm: boolean
  /** Every annotation contents/title/field value/alt text/URL and every AcroForm field value,
   *  joined, for the confidential-term scan. */
  annotationText: string
}

/**
 * REFUTE C1b: what the intake gate needs to stay fail-closed. Text on a page proves nothing about
 * the rest of that page: an image XObject (a scanned page with a typed footer, a logo) and
 * AcroForm/annotation content are rendered by viewers, sent to Anthropic inside the raw PDF, and
 * invisible to getTextContent. The caller blocks on any image or non-link annotation and scans
 * annotationText. Returns null (never throws) when the PDF cannot be parsed or inspected.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection | null> {
  try {
    const pdfjs = await getResolvedPDFJS()
    const ops = pdfjs.OPS as Record<string, number>
    const imageOps = new Set<number>(IMAGE_OP_NAMES.map((n) => ops[n]).filter((v) => typeof v === 'number'))
    if (imageOps.size !== IMAGE_OP_NAMES.length) return null // pdf.js API drift: cannot inspect, fail closed

    const pdf = await getDocumentProxy(bytes)
    const pages: string[] = []
    const imagePages: number[] = []
    const annotationPages: number[] = []
    const annotationParts: string[] = []

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))

      const opList = await page.getOperatorList()
      if (opList.fnArray.some((fn: number) => imageOps.has(fn))) imagePages.push(n)

      const annots = (await page.getAnnotations()) as Array<Record<string, unknown>>
      let blocking = false
      for (const a of annots) {
        if (a.subtype !== 'Link') blocking = true
        for (const key of ['contents', 'title', 'fieldValue', 'alternativeText', 'fieldName', 'url', 'unsafeUrl']) {
          const v = a[key]
          if (typeof v === 'string') annotationParts.push(v)
          else if (Array.isArray(v)) annotationParts.push(v.filter((x) => typeof x === 'string').join(' '))
        }
        const rich = a.contentsObj as { str?: unknown } | undefined
        if (rich && typeof rich.str === 'string') annotationParts.push(rich.str)
      }
      if (blocking) annotationPages.push(n)
    }

    const fields = (await pdf.getFieldObjects()) as Record<string, Array<Record<string, unknown>>> | null
    let hasAcroForm = false
    if (fields) {
      for (const [name, objs] of Object.entries(fields)) {
        hasAcroForm = true
        annotationParts.push(name)
        for (const o of objs ?? []) {
          for (const key of ['value', 'defaultValue']) {
            const v = o[key]
            if (typeof v === 'string') annotationParts.push(v)
            else if (Array.isArray(v)) annotationParts.push(v.filter((x) => typeof x === 'string').join(' '))
          }
        }
      }
    }

    return { pages, imagePages, annotationPages, hasAcroForm, annotationText: annotationParts.join('\n') }
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
