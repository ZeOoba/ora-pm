import { describe, it, expect } from 'vitest'
import { buildSimplePdf, buildSimplePdfBase64 } from '../../../evals/lease-intake-model-eval/build-pdf'

// Structural checks only (no external PDF-reading binary dependency in the test suite --
// this was manually round-tripped through `pdftotext` during development and confirmed to
// extract the exact input text with zero errors; see the eval's README for that record).
describe('buildSimplePdf', () => {
  it('starts with the PDF header and ends with %%EOF', () => {
    const pdf = buildSimplePdf(['hello'])
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4')
    expect(pdf.toString('latin1').endsWith('%%EOF')).toBe(true)
  })

  it('embeds each input line verbatim in the (uncompressed) content stream', () => {
    const pdf = buildSimplePdf(['LEASE AGREEMENT', 'Base Rent: $4,500.00'])
    const text = pdf.toString('latin1')
    expect(text).toContain('(LEASE AGREEMENT) Tj')
    // '$' needs no escaping; '.' needs no escaping -- only \ and unescaped ( ) do.
    expect(text).toContain('(Base Rent: $4,500.00) Tj')
  })

  it('escapes parentheses and backslashes so the content stream stays well-formed', () => {
    const pdf = buildSimplePdf(['Tenant (Suite 100)', 'Path: C:\\Test'])
    const text = pdf.toString('latin1')
    expect(text).toContain('(Tenant \\(Suite 100\\)) Tj')
    expect(text).toContain('(Path: C:\\\\Test) Tj')
  })

  it('the xref byte offsets point at the correct "N 0 obj" markers', () => {
    const pdf = buildSimplePdf(['a', 'b', 'c'])
    const text = pdf.toString('latin1')
    const xrefMatch = text.match(/xref\n0 6\n([\s\S]*?)trailer/)
    expect(xrefMatch).not.toBeNull()
    const entries = xrefMatch![1].trim().split('\n')
    // entry 0 is the free-list head; entries 1..5 are objects 1 0 obj .. 5 0 obj
    for (let i = 1; i <= 5; i++) {
      const offset = Number(entries[i].slice(0, 10))
      const atOffset = text.slice(offset, offset + `${i} 0 obj`.length)
      expect(atOffset).toBe(`${i} 0 obj`)
    }
  })

  it('produces more lines further down the page (decreasing y via Tm)', () => {
    const pdf = buildSimplePdf(['line1', 'line2'])
    const text = pdf.toString('latin1')
    expect(text).toContain('1 0 0 1 72 720 Tm (line1) Tj')
    expect(text).toContain('1 0 0 1 72 706 Tm (line2) Tj')
  })
})

describe('buildSimplePdfBase64', () => {
  it('round-trips to the same bytes as buildSimplePdf', () => {
    const lines = ['LEASE AGREEMENT', 'Term: 2026-01-01 to 2030-12-31']
    const raw = buildSimplePdf(lines)
    const b64 = buildSimplePdfBase64(lines)
    expect(Buffer.from(b64, 'base64').equals(raw)).toBe(true)
  })
})
