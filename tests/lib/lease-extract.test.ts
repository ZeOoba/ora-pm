import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildExtractionRequest, parseExtractionResponse, extractLease } from '../../server/lib/lease-extract'

describe('buildExtractionRequest', () => {
  it('includes the PDF document block and forces the extract_lease tool', () => {
    const req = buildExtractionRequest('BASE64PDF', 'claude-opus-4-8')
    expect(req.model).toBe('claude-opus-4-8')
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'extract_lease' })
    const content = req.messages[0].content as Array<Record<string, unknown>>
    const doc = content.find(b => b.type === 'document') as { source: { data: string } }
    expect(doc.source.data).toBe('BASE64PDF')
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
    const out = await extractLease('BASE64PDF', { apiKey: 'sk-test', model: 'claude-opus-4-8' })
    expect(out.fields.base_rent_monthly).toBe(4500)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect((init.headers as Record<string,string>)['x-api-key']).toBe('sk-test')
  })
  it('throws a sanitized error on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    await expect(extractLease('X', { apiKey: 'k', model: 'claude-opus-4-8' })).rejects.toThrow(/extraction failed/i)
  })
})
