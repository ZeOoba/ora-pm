import { describe, it, expect } from 'vitest'
import { extractPdfText } from '../../server/lib/pdf-extract'
import { buildTextPdf, buildImageOnlyPdf } from '../fixtures/pdf'

describe('extractPdfText', () => {
  it('extracts real text from a PDF with a text layer', async () => {
    const bytes = await buildTextPdf('Hello Zeta World')
    const text = await extractPdfText(bytes)
    expect(text).toMatch(/Hello Zeta World/)
  })

  it('returns empty string for a PDF with no text layer (scanned/image-only stand-in)', async () => {
    const bytes = await buildImageOnlyPdf()
    const text = await extractPdfText(bytes)
    expect(text).toBe('')
  })

  it('returns empty string (fail-open, never throws) for malformed bytes', async () => {
    const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5])
    await expect(extractPdfText(garbage)).resolves.toBe('')
  })
})
