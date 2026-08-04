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

/** Base64-encode PDF bytes the same way the intake route expects
 *  (pdfBase64 of the raw file bytes — real PDFs always start with "%PDF",
 *  which base64-encodes to a "JVBER" prefix; see intake.ts's magic-byte check). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
