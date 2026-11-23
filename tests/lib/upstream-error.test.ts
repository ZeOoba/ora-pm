import { describe, it, expect, vi, afterEach } from 'vitest'
import { describeUpstreamFailure, logUpstreamFailure, UPSTREAM_MESSAGE_CAP } from '../../server/lib/upstream-error'
import { extractAbstract } from '../../server/lib/lease-abstract'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

afterEach(() => vi.restoreAllMocks())

describe('describeUpstreamFailure', () => {
  it('reads status, Anthropic error type, capped message and request-id', async () => {
    const f = await describeUpstreamFailure(json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'x'.repeat(1000) } }, { 'request-id': 'req_123' }))
    expect(f).toMatchObject({ status: 400, type: 'invalid_request_error', requestId: 'req_123' })
    expect(f.message).toHaveLength(UPSTREAM_MESSAGE_CAP)
  })

  it('never throws on a non-JSON body (gateway page)', async () => {
    const f = await describeUpstreamFailure(new Response('<html>bad gateway</html>', { status: 502 }))
    expect(f).toEqual({ status: 502, type: null, message: null, requestId: null })
  })
})

describe('extractAbstract on an upstream failure', () => {
  it('logs status/type/request-id to the Worker log (no document text) and still throws a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'request-id': 'req_9' })))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(extractAbstract(['SECRET LEASE TEXT on page one, long enough to matter.'], { apiKey: 'k', model: 'm' })).rejects.toThrow('status 529')
    const line = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(line).toContain('Anthropic API 529 overloaded_error — Overloaded (request-id req_9)')
    expect(line).not.toContain('SECRET LEASE TEXT')
    vi.unstubAllGlobals()
  })

  it('logUpstreamFailure omits absent parts', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    logUpstreamFailure('x', { status: 401, type: null, message: null, requestId: null })
    expect(log).toHaveBeenCalledWith('[intake] x: Anthropic API 401')
  })
})
