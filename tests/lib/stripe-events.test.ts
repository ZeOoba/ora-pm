import { describe, it, expect, vi } from 'vitest'
import { handleStripeEvent } from '../../server/lib/stripe-events'
import type Stripe from 'stripe'
import type { getDb } from '../../server/db/client'

type DB = ReturnType<typeof getDb>

// Records every UPDATE the handler issues — its patch and its filter chain —
// and resolves each one from a per-call script. The handler now ends every
// UPDATE with .select('id') so it can tell "matched zero rows" (supabase-js
// returns data: [] with no error in that case; WITHOUT .select() it returns
// data: null whether or not anything matched — verified against
// @supabase/supabase-js 2.x) from a real write. The OI-233 fallback (find
// the row by PI metadata.client_request_id when the PI id was never written
// back) hangs off that zero-match signal.
type UpdateCall = { patch: Record<string, unknown>; filters: Array<[method: string, col: string, val: unknown]> }
type UpdateResult = { data: Array<{ id: string }> | null; error: { message: string } | null }

function makeDb(script: UpdateResult[] = [{ data: [{ id: 'p1' }], error: null }]) {
  const calls: UpdateCall[] = []
  const update = vi.fn().mockImplementation((patch: Record<string, unknown>) => {
    const call: UpdateCall = { patch, filters: [] }
    calls.push(call)
    const idx = calls.length - 1
    const builder = {
      eq: vi.fn().mockImplementation((col: string, val: unknown) => { call.filters.push(['eq', col, val]); return builder }),
      is: vi.fn().mockImplementation((col: string, val: unknown) => { call.filters.push(['is', col, val]); return builder }),
      select: vi.fn().mockImplementation(async () => script[idx] ?? { data: [], error: null }),
    }
    return builder
  })
  const from = vi.fn().mockReturnValue({ update })
  return { db: { from } as unknown as DB, calls, update }
}

const MATCHED: UpdateResult = { data: [{ id: 'p1' }], error: null }
const NO_MATCH: UpdateResult = { data: [], error: null }

describe('handleStripeEvent — payment_intent.succeeded', () => {
  it('updates stripe_status to succeeded by PI id (single UPDATE when the id matches)', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_abc', metadata: {} } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toEqual({ stripe_status: 'succeeded' })
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_abc']])
  })

  // OI-233: the PI id was never written back (stripe.ts's post-Stripe UPDATE
  // failed), so the direct match finds nothing. The reservation row still
  // exists with the client_request_id the route stamped into the PI's
  // metadata — complete the write-back from the webhook.
  it('OI-233: falls back to the pending row by metadata.client_request_id when no row carries the PI id, and writes the PI id onto it', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_orphan', metadata: { lease_id: 'l1', tenant_id: 't1', client_request_id: 'crid-1' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual({ stripe_status: 'succeeded', stripe_payment_intent_id: 'pi_orphan' })
    expect(calls[1].filters).toEqual([
      ['eq', 'client_request_id', 'crid-1'],
      ['is', 'stripe_payment_intent_id', null],
    ])
  })

  it('OI-233: does NOT attempt the fallback when the PI carries no client_request_id (autopay PIs from cron.ts)', async () => {
    const { db, calls } = makeDb([NO_MATCH])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_autopay', metadata: { lease_id: 'l1', tenant_id: 't1' } } },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('OI-233: throws (so Stripe retries) when the fallback UPDATE itself errors', async () => {
    const { db } = makeDb([NO_MATCH, { data: null, error: { message: 'connection refused' } }])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_x', metadata: { client_request_id: 'crid-x' } } },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).rejects.toThrow('DB update failed')
  })
})

describe('handleStripeEvent — payment_intent.processing (OI-233 write-back path)', () => {
  // Stripe emits payment_intent.processing right after an ACH confirm — days
  // before succeeded. It is the earliest point the webhook can complete a
  // write-back that stripe.ts failed to make.
  it('advances a pending row to processing by PI id, only if it is still pending (never regresses a later status)', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.processing',
      data: { object: { id: 'pi_proc', metadata: { client_request_id: 'crid-p' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toEqual({ stripe_status: 'processing' })
    expect(calls[0].filters).toEqual([
      ['eq', 'stripe_payment_intent_id', 'pi_proc'],
      ['eq', 'stripe_status', 'pending'],
    ])
  })

  it('falls back to the client_request_id row (PI id NULL) and writes the PI id + processing onto it', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.processing',
      data: { object: { id: 'pi_proc2', metadata: { client_request_id: 'crid-p2' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual({ stripe_status: 'processing', stripe_payment_intent_id: 'pi_proc2' })
    expect(calls[1].filters).toEqual([
      ['eq', 'client_request_id', 'crid-p2'],
      ['is', 'stripe_payment_intent_id', null],
    ])
  })
})

describe('handleStripeEvent — payment_intent.payment_failed', () => {
  it('updates stripe_status to failed with error message in notes', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail', last_payment_error: { message: 'Insufficient funds' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('Insufficient funds') }))
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_fail']])
  })

  it('OI-233: falls back to the client_request_id row when no row carries the PI id', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail2', metadata: { client_request_id: 'crid-f' }, last_payment_error: { message: 'NSF' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', stripe_payment_intent_id: 'pi_fail2' }))
    expect(calls[1].filters).toEqual([
      ['eq', 'client_request_id', 'crid-f'],
      ['is', 'stripe_payment_intent_id', null],
    ])
  })
})

describe('handleStripeEvent — payment_intent.canceled', () => {
  it('updates stripe_status to failed with canceled note', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_cancel' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('canceled') }))
  })

  it('OI-233: falls back to the client_request_id row when no row carries the PI id', async () => {
    const { db, calls } = makeDb([NO_MATCH, MATCHED])
    const event = {
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_cancel2', metadata: { client_request_id: 'crid-c' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls).toHaveLength(2)
    expect(calls[1].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', stripe_payment_intent_id: 'pi_cancel2' }))
  })
})

describe('handleStripeEvent — charge.failed', () => {
  it('updates stripe_status to returned with ACH return info', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'charge.failed',
      data: {
        object: {
          id: 'ch_fail',
          payment_intent: 'pi_ach',
          failure_code: 'insufficient_funds',
          failure_message: 'Your card has insufficient funds.',
        },
      },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'returned', notes: expect.stringContaining('insufficient_funds') }))
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_ach']])
  })

  it('does nothing if charge has no payment_intent', async () => {
    const { db, update } = makeDb()
    const event = {
      type: 'charge.failed',
      data: { object: { id: 'ch_nopi', payment_intent: null, failure_code: 'lost_card' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(update).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — charge.dispute.created', () => {
  it('updates stripe_status to failed with dispute reason', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_dis', reason: 'fraudulent' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].patch).toEqual(expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('fraudulent') }))
    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_dis']])
  })

  it('does nothing if dispute has no payment_intent', async () => {
    const { db, update } = makeDb()
    const event = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_nopi', payment_intent: null, reason: 'general' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(update).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — unknown event type', () => {
  it('silently ignores unknown event types', async () => {
    const { db, update } = makeDb()
    const event = {
      type: 'customer.created',
      data: { object: {} },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).resolves.toBeUndefined()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — DB error propagation', () => {
  it('throws when DB update fails so Stripe retries delivery', async () => {
    const { db } = makeDb([{ data: null, error: { message: 'connection refused' } }])
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_dberr', metadata: {} } },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db)).rejects.toThrow('DB update failed')
  })
})

describe('handleStripeEvent — expanded payment_intent object', () => {
  it('extracts .id when charge.payment_intent is an expanded object', async () => {
    const { db, calls } = makeDb([MATCHED])
    const event = {
      type: 'charge.failed',
      data: {
        object: {
          id: 'ch_exp',
          payment_intent: { id: 'pi_expanded', object: 'payment_intent' },
          failure_code: 'nsf',
          failure_message: 'Insufficient funds',
        },
      },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db)

    expect(calls[0].filters).toEqual([['eq', 'stripe_payment_intent_id', 'pi_expanded']])
  })
})
