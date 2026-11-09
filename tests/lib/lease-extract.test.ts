import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildExtractionRequest, parseExtractionResponse, extractLease } from '../../server/lib/lease-extract'

describe('buildExtractionRequest', () => {
  // REFUTE round 2: the request carries ONLY the scanned per-page text, never the raw PDF, so what
  // leaves is exactly what the confidentiality scan saw.
  it('sends the scanned pages as ONE text block with page separators, and forces the extract_lease tool', () => {
    const req = buildExtractionRequest(['First page text', 'Second page text'], 'claude-opus-5')
    expect(req.model).toBe('claude-opus-5')
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'extract_lease' })
    const content = req.messages[0].content as Array<Record<string, unknown>>
    expect(content.every(b => b.type === 'text')).toBe(true)
    const all = content.map(b => b.text as string).join('\n')
    expect(all).toMatch(/--- Page 1 of 2 ---\nFirst page text/)
    expect(all).toMatch(/--- Page 2 of 2 ---\nSecond page text/)
  })

  it('has no document/image block and no base64 source anywhere in the request', () => {
    const json = JSON.stringify(buildExtractionRequest(['Only text'], 'claude-opus-5'))
    expect(json).not.toMatch(/"document"|"image"|"base64"|application\/pdf/)
  })

  it('rejects a non-array input (a raw base64 PDF string must never be accepted)', () => {
    expect(() => buildExtractionRequest('JVBERi0xLjcK' as unknown as string[], 'm')).toThrow(/page text/i)
  })

  it('describes the input as extracted lease text to the model (prompt + tool)', () => {
    const req = buildExtractionRequest(['x'], 'm')
    const prompt = (req.messages[0].content as Array<{ text: string }>).map(b => b.text).join(' ')
    expect(prompt).toMatch(/extracted text/i)
    expect(req.tools[0].description).toMatch(/lease text/i)
  })
})

describe('parseExtractionResponse', () => {
  it('extracts fields + confidence from the tool_use block', () => {
    const out = parseExtractionResponse({
      content: [{ type: 'tool_use', name: 'extract_lease', input: {
        base_rent_monthly: 4500, start_date: '2026-01-01', end_date: '2030-12-31',
        _confidence: { base_rent_monthly: 0.98, start_date: 0.6 },
      }}],
    })
    expect(out.fields.base_rent_monthly).toBe(4500)
    expect(out.confidence.start_date).toBe(0.6)
    expect(out.warnings).toEqual([])
  })
  it('warns when no tool_use block is present', () => {
    const out = parseExtractionResponse({ content: [{ type: 'text', text: 'I cannot read this.' }] })
    expect(out.warnings.length).toBeGreaterThan(0)
    expect(out.fields).toEqual({})
  })
})

describe('extractLease', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('calls the Anthropic endpoint with the api key header and returns parsed fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'extract_lease', input: { base_rent_monthly: 4500, _confidence: {} } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await extractLease(['Lease page one'], { apiKey: 'sk-test', model: 'claude-opus-5' })
    expect(out.fields.base_rent_monthly).toBe(4500)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect((init.headers as Record<string,string>)['x-api-key']).toBe('sk-test')
    expect(String(init.body)).toContain('Lease page one')
  })
  it('throws a sanitized error on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    await expect(extractLease(['X'], { apiKey: 'k', model: 'claude-opus-5' })).rejects.toThrow(/extraction failed/i)
  })
})
