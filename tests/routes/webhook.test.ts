import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockConstructEventAsync = vi.hoisted(() => vi.fn())
const mockHandleStripeEvent = vi.hoisted(() => vi.fn())
const mockFrom = vi.hoisted(() => vi.fn())

vi.mock('../../server/lib/stripe', () => ({
  getStripe: () => ({
    webhooks: {
      constructEventAsync: mockConstructEventAsync,
    },
  }),
}))

vi.mock('../../server/lib/stripe-events', () => ({
  handleStripeEvent: mockHandleStripeEvent,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mockFrom }),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()

beforeEach(() => {
  vi.clearAllMocks()
})

function makeInsert(error: unknown) {
  const insert = vi.fn().mockResolvedValue({ error })
  return { insert }
}

function makeUpdateChain(error: unknown = null) {
  const eq = vi.fn().mockResolvedValue({ error })
  const update = vi.fn().mockReturnValue({ eq })
  return { update, eq }
}

// OI-222: the 23505 branch now reads back the existing row's status via
// .select('status').eq('id', event.id).single() before deciding to skip.
function makeSelectChain(data: unknown, error: unknown = null) {
  const single = vi.fn().mockResolvedValue({ data, error })
  const eq = vi.fn().mockReturnValue({ single })
  const select = vi.fn().mockReturnValue({ eq })
  return { select, eq, single }
}

describe('POST /api/webhooks/stripe', () => {
  it('returns 400 if stripe-signature header is missing', async () => {
    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      body: '{}',
    }, env)
    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/stripe-signature/i)
  })

  // OI-042: routes through the dbError helper (Task 7), which hardcodes 500
  // and a generic public message — the raw Stripe SDK detail (algorithm,
  // timestamp skew, raw-body hints) now only ever reaches console.error.
  it('returns 500 with a generic message if signature verification fails', async () => {
    mockConstructEventAsync.mockRejectedValue(new Error('Invalid signature'))

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad_sig' },
      body: '{"id":"evt_test"}',
    }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/signature/i)
    expect(json.error).not.toMatch(/Invalid signature/)
  })

  it('returns 200 with skipped:true for duplicate event whose row is already processed (idempotency)', async () => {
    const fakeEvent = { id: 'evt_dup', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)

    // 23505 = PostgreSQL unique_violation = PK conflict. OI-222: a conflict alone
    // is NOT proof the event was handled — the route must read the row's status
    // and only skip when it is 'processed'.
    const { insert } = makeInsert({ code: '23505', message: 'duplicate key' })
    const { select, eq } = makeSelectChain({ status: 'processed' })
    mockFrom.mockReturnValue({ insert, select })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean; skipped: boolean }
    expect(json.skipped).toBe(true)
    expect(insert).toHaveBeenCalledWith({ id: 'evt_dup', event_type: 'payment_intent.succeeded' })
    expect(select).toHaveBeenCalledWith('status')
    expect(eq).toHaveBeenCalledWith('id', 'evt_dup')
    expect(mockHandleStripeEvent).not.toHaveBeenCalled()
  })

  // OI-222: a retry of an event whose first attempt FAILED must be re-processed,
  // not dropped. Before the fix, every 23505 was treated as "already handled",
  // so a transient handler failure (DB blip, timeout) on e.g.
  // payment_intent.succeeded permanently lost the ledger credit even though
  // Stripe delivered and retried the event.
  it('OI-222: re-runs the handler and marks processed when the conflicting row is status:failed', async () => {
    const fakeEvent = { id: 'evt_retry', type: 'payment_intent.succeeded', data: { object: { id: 'pi_retry' } } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)
    mockHandleStripeEvent.mockResolvedValue(undefined)

    const { insert } = makeInsert({ code: '23505', message: 'duplicate key' })
    const { select, eq: selectEq } = makeSelectChain({ status: 'failed' })
    const { update, eq: updateEq } = makeUpdateChain()
    mockFrom.mockReturnValue({ insert, select, update })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean; skipped?: boolean }
    expect(json.received).toBe(true)
    expect(json.skipped).toBeUndefined()
    expect(select).toHaveBeenCalledWith('status')
    expect(selectEq).toHaveBeenCalledWith('id', 'evt_retry')
    expect(mockHandleStripeEvent).toHaveBeenCalledTimes(1)
    expect(mockHandleStripeEvent).toHaveBeenCalledWith(fakeEvent, expect.anything())
    expect(update).toHaveBeenCalledWith({ status: 'processed' })
    expect(updateEq).toHaveBeenCalledWith('id', 'evt_retry')
  })

  it('OI-222: marks failed again and returns 500 when the retry of a status:failed row also throws', async () => {
    const fakeEvent = { id: 'evt_retry_again', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)
    mockHandleStripeEvent.mockRejectedValue(new Error('still broken'))

    const { insert } = makeInsert({ code: '23505', message: 'duplicate key' })
    const { select } = makeSelectChain({ status: 'failed' })
    const { update, eq } = makeUpdateChain()
    mockFrom.mockReturnValue({ insert, select, update })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(500)
    expect(mockHandleStripeEvent).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ status: 'failed' })
    expect(update).not.toHaveBeenCalledWith({ status: 'processed' })
    expect(eq).toHaveBeenCalledWith('id', 'evt_retry_again')
  })

  it('OI-222: returns 500 and does not call the handler if the status read-back after 23505 fails (Stripe will retry)', async () => {
    const fakeEvent = { id: 'evt_readback_err', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)

    const { insert } = makeInsert({ code: '23505', message: 'duplicate key' })
    const { select } = makeSelectChain(null, { code: '08006', message: 'connection error' })
    mockFrom.mockReturnValue({ insert, select })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/connection error/)
    expect(mockHandleStripeEvent).not.toHaveBeenCalled()
  })

  it('returns 200, calls handleStripeEvent, marks processed for new events', async () => {
    const fakeEvent = { id: 'evt_new', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test' } } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)
    mockHandleStripeEvent.mockResolvedValue(undefined)

    const { insert } = makeInsert(null)
    const { update, eq } = makeUpdateChain()
    mockFrom.mockReturnValue({ insert, update })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean; skipped?: boolean }
    expect(json.received).toBe(true)
    expect(json.skipped).toBeUndefined()
    expect(mockHandleStripeEvent).toHaveBeenCalledWith(fakeEvent, expect.anything())
    expect(update).toHaveBeenCalledWith({ status: 'processed' })
    expect(eq).toHaveBeenCalledWith('id', 'evt_new')
  })

  it('marks event failed and returns 500 if handleStripeEvent throws', async () => {
    const fakeEvent = { id: 'evt_throw', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)
    mockHandleStripeEvent.mockRejectedValue(new Error('handler blew up'))

    const { insert } = makeInsert(null)
    const { update, eq } = makeUpdateChain()
    mockFrom.mockReturnValue({ insert, update })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(500)
    expect(update).toHaveBeenCalledWith({ status: 'failed' })
    expect(eq).toHaveBeenCalledWith('id', 'evt_throw')
  })

  it('returns 500 and does not call handler if DB INSERT fails', async () => {
    const fakeEvent = { id: 'evt_dberr', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)

    // Non-23505 error = real DB failure, not a duplicate
    const { insert } = makeInsert({ code: '08006', message: 'connection error' })
    mockFrom.mockReturnValue({ insert })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(500)
    expect(mockHandleStripeEvent).not.toHaveBeenCalled()
  })

  // E8 (PR #53 REFUTE follow-up): neither status write was error-checked. A failed 'processed'
  // write returned 200, so Stripe stopped retrying while the row stayed 'pending'. That is safe
  // only by accident; the route now reports it (500 -> Stripe retries -> the CAS-guarded handler
  // re-runs as a no-op and the processed write gets another chance) and logs it.
  it('E8: returns 500 (Stripe retries) and logs when the processed-status write fails', async () => {
    const fakeEvent = { id: 'evt_mark_fail', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)
    mockHandleStripeEvent.mockResolvedValue(undefined)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { insert } = makeInsert(null)
    const { update } = makeUpdateChain({ code: '08006', message: 'connection reset while marking processed' })
    mockFrom.mockReturnValue({ insert, update })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/connection reset/) // generic public message
    expect(mockHandleStripeEvent).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ status: 'processed' })
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/evt_mark_fail/)
    errSpy.mockRestore()
  })

  it('E8: still returns 500 and logs both failures when the handler throws AND the failed-status write fails', async () => {
    const fakeEvent = { id: 'evt_double_fail', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)
    mockHandleStripeEvent.mockRejectedValue(new Error('handler blew up'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { insert } = makeInsert(null)
    const { update } = makeUpdateChain({ code: '08006', message: 'connection reset while marking failed' })
    mockFrom.mockReturnValue({ insert, update })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(500)
    expect(update).toHaveBeenCalledWith({ status: 'failed' })
    const logged = errSpy.mock.calls.flat().map(String).join(' ')
    expect(logged).toMatch(/evt_double_fail/)
    expect(logged).toMatch(/marking failed/)
    errSpy.mockRestore()
  })
})
