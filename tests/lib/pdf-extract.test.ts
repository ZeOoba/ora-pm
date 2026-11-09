import { describe, it, expect } from 'vitest'
import { extractPdfText, extractPdfPages, pagesLackingTextLayer, MIN_PAGE_TEXT_CHARS, inspectPdf } from '../../server/lib/pdf-extract'
import { buildTextPdf, buildImageOnlyPdf, buildMultiPagePdf, buildImagePlusFooterPdf, buildFormFieldPdf } from '../fixtures/pdf'

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

describe('extractPdfPages (per-page text, for the intake text-layer gate)', () => {
  it('returns one entry per page, in order, with each page own text', async () => {
    const bytes = await buildMultiPagePdf(['Page one lease recitals and parties', null, 'Page three rent schedule and term'])
    const pages = await extractPdfPages(bytes)
    expect(pages).not.toBeNull()
    expect(pages).toHaveLength(3)
    expect(pages![0]).toMatch(/Page one lease recitals/)
    expect(pages![1].trim()).toBe('')
    expect(pages![2]).toMatch(/Page three rent schedule/)
  })

  it('returns null (never throws) for malformed bytes', async () => {
    const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5])
    await expect(extractPdfPages(garbage)).resolves.toBeNull()
  })
})

describe('pagesLackingTextLayer', () => {
  it('flags every page below the non-whitespace threshold (1-based page numbers)', () => {
    const full = 'x'.repeat(MIN_PAGE_TEXT_CHARS)
    expect(pagesLackingTextLayer([full, '', full, '   \n\t  ', 'Page 3'])).toEqual([2, 4, 5])
  })

  it('counts NON-whitespace characters, so a page padded with spaces/newlines is not a text layer', () => {
    const padded = 'a b c d e f g h i j k l m n o p q r s t u v w x'.padEnd(500, ' ')
    expect(padded.replace(/\s/g, '').length).toBeLessThan(MIN_PAGE_TEXT_CHARS)
    expect(pagesLackingTextLayer([padded])).toEqual([1])
  })

  it('a document with zero pages is treated as lacking (fail closed)', () => {
    expect(pagesLackingTextLayer([])).toEqual([0])
  })

  it('passes a document whose every page clears the threshold', () => {
    expect(pagesLackingTextLayer(['Ordinary lease terms, nothing sensitive here'])).toEqual([])
  })
})

// REFUTE C1b: per-page text alone is not enough. A page can carry a 25+ char footer AND a raster
// image (scan, logo), and AcroForm/annotation text never appears in getTextContent.
describe('inspectPdf (image XObjects, annotations, AcroForm)', () => {
  it('reports no images or annotations for a plain text PDF', async () => {
    const r = await inspectPdf(await buildMultiPagePdf(['Commercial lease cover sheet for the premises', 'Base rent schedule and the term of the lease']))
    expect(r).not.toBeNull()
    expect(r!.pages).toHaveLength(2)
    expect(r!.imagePages).toEqual([])
    expect(r!.annotationPages).toEqual([])
    expect(r!.hasAcroForm).toBe(false)
  })

  it('flags a page that paints an image even when its footer clears the text threshold', async () => {
    const r = await inspectPdf(await buildImagePlusFooterPdf('CONFIDENTIAL  ORA-000123  Page 3 of 20'))
    expect(pagesLackingTextLayer(r!.pages)).toEqual([]) // the old gate would have passed it
    expect(r!.imagePages).toEqual([1])
  })

  it('flags form-field widgets and surfaces their values for the term scan', async () => {
    const r = await inspectPdf(await buildFormFieldPdf('Lease Agreement - Exhibit B - Page 3', 'Blueridge Partners'))
    expect(r!.pages.join(' ')).not.toMatch(/Blueridge/) // invisible to getTextContent
    expect(r!.annotationPages).toEqual([1])
    expect(r!.hasAcroForm).toBe(true)
    expect(r!.annotationText).toMatch(/Blueridge Partners/)
  })

  it('returns null (never throws) for malformed bytes', async () => {
    await expect(inspectPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]))).resolves.toBeNull()
  })
})
