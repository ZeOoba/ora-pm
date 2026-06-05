import { Hono } from 'hono'
import { getStripe } from '../lib/stripe'
import { getDb } from '../db/client'
import { handleStripeEvent } from '../lib/stripe-events'
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
    return c.json({ error: `Webhook signature verification failed: ${(err as Error).message}` }, 400)
  }

  const db = getDb(c.env)

  // Idempotency: INSERT then check for PK violation (23505 = unique_violation).
  // Two concurrent deliveries both attempt the insert; the second gets 23505 and skips.
  const { error: insertError } = await db
    .from('stripe_webhook_events')
    .insert({ id: event.id, event_type: event.type })

  if (insertError) {
    if (insertError.code === '23505') return c.json({ received: true, skipped: true })
    return c.json({ error: 'Failed to record event' }, 500)
  }

  try {
    await handleStripeEvent(event, db)
  } catch (err) {
    await db.from('stripe_webhook_events').update({ status: 'failed' }).eq('id', event.id)
    return c.json({ error: `Event handling failed: ${(err as Error).message}` }, 500)
  }

  await db.from('stripe_webhook_events').update({ status: 'processed' }).eq('id', event.id)

  return c.json({ received: true })
})
