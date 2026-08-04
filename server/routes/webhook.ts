import { Hono } from 'hono'
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

  let event: import('stripe').default.Event
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, c.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    // Signature-mismatch detail (algorithm, timestamp skew, raw-body hints)
    // is internal — the client only ever needs to know verification failed.
    return dbError(c, err as Error, 'Webhook signature verification failed')
  }

  const db = getDb(c.env)

  // Idempotency: INSERT then check for PK violation (23505 = unique_violation).
  // Two concurrent deliveries both attempt the insert; the second gets 23505 and skips.
  const { error: insertError } = await db
    .from('stripe_webhook_events')
    .insert({ id: event.id, event_type: event.type })

  if (insertError) {
    if (insertError.code === '23505') return c.json({ received: true, skipped: true })
    return dbError(c, insertError, 'Failed to record event')
  }

  try {
    await handleStripeEvent(event, db)
  } catch (err) {
    await db.from('stripe_webhook_events').update({ status: 'failed' }).eq('id', event.id)
    return dbError(c, err as Error, 'Event handling failed')
  }

  await db.from('stripe_webhook_events').update({ status: 'processed' }).eq('id', event.id)

  return c.json({ received: true })
})
