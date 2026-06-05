import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const { mockConstructEvent, mockHandleStripeEvent, mockFrom } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockHandleStripeEvent: vi.fn(),
  mockFrom: vi.fn(),
}))

vi.mock('../../server/lib/stripe', () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: mockConstructEvent,
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/webhooks/stripe', () => {
  it('returns 400 if stripe-signature header is missing', async () => {
    const app = createApp()
    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      body: '{}',
    }, env)
    expect(res.status).toBe(400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any
    expect(json.error).toMatch(/stripe-signature/i)
  })

  it('returns 400 if signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('Invalid signature') })

    const app = createApp()
    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad_sig' },
      body: '{"id":"evt_test"}',
    }, env)
    expect(res.status).toBe(400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any
    expect(json.error).toMatch(/signature/i)
  })

  it('returns 200 with skipped:true if event already processed (idempotency)', async () => {
    const fakeEvent = { id: 'evt_already', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEvent.mockReturnValue(fakeEvent)

    // DB returns existing record for this event
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'evt_already' }, error: null }),
        }),
      }),
    })

    const app = createApp()
    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any
    expect(json.skipped).toBe(true)
    expect(mockHandleStripeEvent).not.toHaveBeenCalled()
  })

  it('returns 200 and calls handleStripeEvent for new events', async () => {
    const fakeEvent = { id: 'evt_new', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test' } } }
    mockConstructEvent.mockReturnValue(fakeEvent)
    mockHandleStripeEvent.mockResolvedValue(undefined)

    // DB returns no existing record → new event
    const mockInsert = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'stripe_webhook_events') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: mockInsert,
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        }
      }
      return { select: vi.fn(), insert: vi.fn(), update: vi.fn() }
    })

    const app = createApp()
    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any
    expect(json.received).toBe(true)
    expect(json.skipped).toBeUndefined()
    expect(mockInsert).toHaveBeenCalledWith({ id: 'evt_new', event_type: 'payment_intent.succeeded' })
    expect(mockHandleStripeEvent).toHaveBeenCalledWith(fakeEvent, expect.anything())
  })

  it('marks event as failed and returns 500 if handleStripeEvent throws', async () => {
    const fakeEvent = { id: 'evt_throw', type: 'payment_intent.succeeded', data: { object: {} } }
    mockConstructEvent.mockReturnValue(fakeEvent)
    mockHandleStripeEvent.mockRejectedValue(new Error('handler blew up'))

    const mockInsert = vi.fn().mockResolvedValue({ error: null })
    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })
    const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'stripe_webhook_events') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          insert: mockInsert,
          update: mockUpdate,
        }
      }
      return { select: vi.fn(), insert: vi.fn(), update: vi.fn() }
    })

    const app = createApp()
    const res = await app.request('/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: JSON.stringify(fakeEvent),
    }, env)
    expect(res.status).toBe(500)
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'failed' })
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'evt_throw')
  })
})
