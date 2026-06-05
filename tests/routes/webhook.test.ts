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

  it('returns 400 if signature verification fails', async () => {
    mockConstructEventAsync.mockRejectedValue(new Error('Invalid signature'))

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad_sig' },
      body: '{"id":"evt_test"}',
    }, env)
    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/signature/i)
  })

  it('returns 200 with skipped:true for duplicate event (idempotency)', async () => {
    const fakeEvent = { id: 'evt_dup', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEventAsync.mockResolvedValue(fakeEvent)

    // 23505 = PostgreSQL unique_violation = PK conflict = already processed
    const { insert } = makeInsert({ code: '23505', message: 'duplicate key' })
    mockFrom.mockReturnValue({ insert })

    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean; skipped: boolean }
    expect(json.skipped).toBe(true)
    expect(insert).toHaveBeenCalledWith({ id: 'evt_dup', event_type: 'payment_intent.succeeded' })
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
})
