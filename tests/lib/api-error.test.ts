import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { dbError, userRuleMessage } from '../../server/lib/api-error'

const respond = (err: { message: string; code?: string }) => {
  const app = new Hono()
  app.get('/', (c) => dbError(c, err, 'Failed to create payment'))
  return app.request('/')
}

describe('dbError (OI-042)', () => {
  it('hides raw database errors behind the public message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await respond({ code: '23514', message: 'new row for relation "payments" violates check constraint "payments_amount_check"' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create payment' })
  })

  it("shows a 'bf: ' refusal (0030) as written: 422, or 409 when the data moved / already exists", async () => {
    const res = await respond({ code: '23514', message: 'bf: lease L has a balance forward from QuickBooks as of 2026-11-12; its payments dated on or before then (2026-11-01) cannot change.' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'lease L has a balance forward from QuickBooks as of 2026-11-12; its payments dated on or before then (2026-11-01) cannot change.' })
    expect((await respond({ code: '40001', message: 'bf: preview again' })).status).toBe(409)
    expect((await respond({ code: '23505', message: 'bf: already has one' })).status).toBe(409)
  })

  it('only the exact prefix counts', () => {
    expect(userRuleMessage({ message: 'bf: x' })).toBe('x')
    expect(userRuleMessage({ message: 'BF: x' })).toBeNull()
    expect(userRuleMessage({ message: 'error: bf: x' })).toBeNull()
    expect(userRuleMessage(null)).toBeNull()
  })
})
