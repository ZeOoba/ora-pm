// tests/fixtures/pdf.ts
//
// Small real PDF fixtures for the intake content-scan tests. Built with
// pdf-lib (a test-only devDependency — never imported by server code) so the
// bytes are genuinely valid PDFs that unpdf/pdf.js can parse, not
// hand-rolled approximations.
import { PDFDocument, StandardFonts } from 'pdf-lib'

/** A one-page PDF whose only content is the given text, drawn as real text
 *  (not an image) — so it has an extractable text layer. */
export async function buildTextPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([300, 150])
  page.drawText(text, { x: 20, y: 100, size: 12, font })
  return doc.save()
}

/** A one-page PDF with a drawn shape but NO text objects — stands in for a
 *  scanned/image-only PDF: pdf.js finds no text layer either way. */
export async function buildImageOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 150])
  page.drawRectangle({ x: 10, y: 10, width: 100, height: 50, color: undefined, borderWidth: 1 })
  return doc.save()
}

/** A multi-page PDF: each entry is one page. A string is drawn as real text
 *  (extractable text layer); `null` is a page with only a drawn shape (no
 *  text layer, the scanned/image-only stand-in). Models the mixed document
 *  the per-page text-layer gate exists for: a typed cover page in front of
 *  scanned lease pages. */
export async function buildMultiPagePdf(pages: Array<string | null>): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    const page = doc.addPage([400, 150])
    if (text === null) {
      page.drawRectangle({ x: 10, y: 10, width: 100, height: 50, color: undefined, borderWidth: 1 })
    } else {
      page.drawText(text, { x: 20, y: 100, size: 10, font })
    }
  }
  return doc.save()
}

/** Base64-encode PDF bytes the same way the intake route expects
 *  (pdfBase64 of the raw file bytes — real PDFs always start with "%PDF",
 *  which base64-encodes to a "JVBER" prefix; see intake.ts's magic-byte check). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// 1x1 PNG: the smallest real raster image pdf-lib can embed as an image XObject.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** REFUTE C1b (G): a page that paints a raster image (a scanned page, or a logo) plus a text
 *  footer long enough to clear the per-page text threshold on its own. */
export async function buildImagePlusFooterPdf(footer: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const png = await doc.embedPng(Uint8Array.from(atob(TINY_PNG_B64), (ch) => ch.charCodeAt(0)))
  const page = doc.addPage([400, 200])
  page.drawImage(png, { x: 10, y: 30, width: 380, height: 150 })
  page.drawText(footer, { x: 20, y: 10, size: 8, font })
  return doc.save()
}

/** REFUTE C1b (A): a text page whose AcroForm text field carries `fieldValue` — rendered by
 *  viewers, but invisible to getTextContent. */
export async function buildFormFieldPdf(header: string, fieldValue: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 200])
  page.drawText(header, { x: 20, y: 170, size: 10, font })
  const field = doc.getForm().createTextField('landlord')
  field.setText(fieldValue)
  field.addToPage(page, { x: 20, y: 60, width: 250, height: 30 })
  return doc.save()
}
