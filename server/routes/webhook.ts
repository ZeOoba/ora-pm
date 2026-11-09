import { Hono } from 'hono'
import type Stripe from 'stripe'
import { getStripe } from '../lib/stripe'
import { getDb } from '../db/client'
import { handleStripeEvent } from '../lib/stripe-events'
import { dbError } from '../lib/api-error'
import type { Env } from '../index'

export const webhookRouter = new Hono<{ Bindings: Env }>()

webhookRouter.post('/stripe', async (c) => {
  const sig = c.req.header('stripe-signature')
  if (!sig) return c.json({ error: 'Missing stripe-signature header' }, 400)

  const rawBody = await c.req.text()
  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, c.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    // Signature-mismatch detail (algorithm, timestamp skew, raw-body hints)
    // is internal — the client only ever needs to know verification failed.
    return dbError(c, err as Error, 'Webhook signature verification failed')
  }

  const db = getDb(c.env)

  // Idempotency: INSERT then check for PK violation (23505 = unique_violation).
  // Two concurrent deliveries both attempt the insert; the second gets 23505.
  const { error: insertError } = await db
    .from('stripe_webhook_events')
    .insert({ id: event.id, event_type: event.type })

  if (insertError) {
    if (insertError.code !== '23505') return dbError(c, insertError, 'Failed to record event')

    // OI-222: a PK conflict is NOT proof the event was handled. A prior attempt
    // may have thrown and marked the row 'failed' (500 → Stripe retries). Read
    // the row's status: skip only a fully 'processed' event (re-running a
    // side-effecting handler could double-apply it); anything else falls
    // through to the handler below exactly like a fresh insert.
    const { data: existing, error: statusError } = await db
      .from('stripe_webhook_events')
      .select('status')
      .eq('id', event.id)
      .single()

    if (statusError) return dbError(c, statusError, 'Failed to read event status')
    if (existing?.status === 'processed') return c.json({ received: true, skipped: true })
  }

  try {
    await handleStripeEvent(event, db, stripe)
  } catch (err) {
    const { error: markFailedError } = await db.from('stripe_webhook_events').update({ status: 'failed' }).eq('id', event.id)
    if (markFailedError) {
      // The 500 below already makes Stripe retry, and a row left 'pending' is re-run on retry
      // exactly like a 'failed' one (only 'processed' is skipped), so this is log-only.
      console.error(`[ORA PM] webhook ${event.id} (${event.type}): could not mark event failed:`, markFailedError.code, markFailedError.message)
    }
    return dbError(c, err as Error, 'Event handling failed')
  }

  // E8: an unchecked write here returned 200 with the row still 'pending', so Stripe stopped
  // retrying and the idempotency ledger silently disagreed with what was applied. Report it
  // instead: a 500 makes Stripe redeliver. Re-running the handler is safe: every payments
  // transition in stripe-events.ts is an ALLOWED_FROM compare-and-swap, and the one event a CAS
  // alone cannot make replay-safe (charge.dispute.created after a won dispute restored
  // 'succeeded') re-reads the dispute's live status before writing.
  const { error: markProcessedError } = await db.from('stripe_webhook_events').update({ status: 'processed' }).eq('id', event.id)
  if (markProcessedError) {
    console.error(`[ORA PM] webhook ${event.id} (${event.type}): handled, but could not mark processed; returning 500 so Stripe retries`)
    return dbError(c, markProcessedError, 'Failed to record event status')
  }

  return c.json({ received: true })
})
