import { describe, it, expect, vi } from 'vitest'
import { handleStripeEvent } from '../../server/lib/stripe-events'
import type Stripe from 'stripe'
import type { getDb } from '../../server/db/client'

type DB = ReturnType<typeof getDb>

function makeDb() {
  const eqFn = vi.fn().mockResolvedValue({ error: null })
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn })
  const maybeSingleFn = vi.fn().mockResolvedValue({ data: null, error: null })
  const eqSelectFn = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn })
  const selectFn = vi.fn().mockReturnValue({ eq: eqSelectFn })
  const from = vi.fn().mockReturnValue({ select: selectFn, update: updateFn })
  return { from, updateFn, eqFn } as unknown as DB & { updateFn: typeof updateFn; eqFn: typeof eqFn }
}

describe('handleStripeEvent — payment_intent.succeeded', () => {
  it('updates stripe_status to succeeded', async () => {
    const db = makeDb()
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_abc', metadata: {} } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db as unknown as DB)

    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).toHaveBeenCalledWith({ stripe_status: 'succeeded' })
    expect((db as unknown as { eqFn: ReturnType<typeof vi.fn> }).eqFn).toHaveBeenCalledWith('stripe_payment_intent_id', 'pi_abc')
  })
})

describe('handleStripeEvent — payment_intent.payment_failed', () => {
  it('updates stripe_status to failed with error message in notes', async () => {
    const db = makeDb()
    const event = {
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail', last_payment_error: { message: 'Insufficient funds' } } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db as unknown as DB)

    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('Insufficient funds') })
    )
  })
})

describe('handleStripeEvent — payment_intent.canceled', () => {
  it('updates stripe_status to failed with canceled note', async () => {
    const db = makeDb()
    const event = {
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_cancel' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db as unknown as DB)

    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('canceled') })
    )
  })
})

describe('handleStripeEvent — charge.failed', () => {
  it('updates stripe_status to returned with ACH return info', async () => {
    const db = makeDb()
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

    await handleStripeEvent(event, db as unknown as DB)

    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_status: 'returned', notes: expect.stringContaining('insufficient_funds') })
    )
    expect((db as unknown as { eqFn: ReturnType<typeof vi.fn> }).eqFn).toHaveBeenCalledWith('stripe_payment_intent_id', 'pi_ach')
  })

  it('does nothing if charge has no payment_intent', async () => {
    const db = makeDb()
    const event = {
      type: 'charge.failed',
      data: { object: { id: 'ch_nopi', payment_intent: null, failure_code: 'lost_card' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db as unknown as DB)

    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — charge.dispute.created', () => {
  it('updates stripe_status to failed with dispute reason', async () => {
    const db = makeDb()
    const event = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_dis', reason: 'fraudulent' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db as unknown as DB)

    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_status: 'failed', notes: expect.stringContaining('fraudulent') })
    )
    expect((db as unknown as { eqFn: ReturnType<typeof vi.fn> }).eqFn).toHaveBeenCalledWith('stripe_payment_intent_id', 'pi_dis')
  })

  it('does nothing if dispute has no payment_intent', async () => {
    const db = makeDb()
    const event = {
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_nopi', payment_intent: null, reason: 'general' } },
    } as unknown as Stripe.Event

    await handleStripeEvent(event, db as unknown as DB)

    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).not.toHaveBeenCalled()
  })
})

describe('handleStripeEvent — unknown event type', () => {
  it('silently ignores unknown event types', async () => {
    const db = makeDb()
    const event = {
      type: 'customer.created',
      data: { object: {} },
    } as unknown as Stripe.Event

    await expect(handleStripeEvent(event, db as unknown as DB)).resolves.toBeUndefined()
    expect((db as unknown as { updateFn: ReturnType<typeof vi.fn> }).updateFn).not.toHaveBeenCalled()
  })
})
