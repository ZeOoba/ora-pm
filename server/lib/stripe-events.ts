import type Stripe from 'stripe'
import type { getDb } from '../db/client'

type Db = ReturnType<typeof getDb>
type PaymentPatch = Record<string, string | null>

function piId(ref: string | Stripe.PaymentIntent | null): string | null {
  if (!ref) return null
  return typeof ref === 'string' ? ref : ref.id
}

// UPDATE payments by PaymentIntent id, with the OI-233 fallback.
//
// Every UPDATE here ends in .select('id') on purpose: without it supabase-js
// resolves data: null whether or not any row matched (PostgREST's
// return=minimal), so a write that hit nothing is indistinguishable from one
// that worked. With it, a zero-match resolves data: [] and no error
// (verified against @supabase/supabase-js 2.x).
//
// Zero rows matched by PI id means server/routes/stripe.ts never got to
// write the PI id onto the 'pending' reservation row it inserted BEFORE
// calling Stripe (its post-Stripe UPDATE failed — OI-233). That row still
// exists, keyed by the client_request_id the route also stamped into the
// PaymentIntent's metadata, with stripe_payment_intent_id NULL. Complete the
// write-back here: set the PI id together with the status this event
// carries. The `IS NULL` guard means a row that was written back after all
// (a race with a late route retry) is never overwritten twice.
//
// PIs with no client_request_id in metadata (cron.ts autopay debits) have
// no reservation row to fall back to — their insert-after-Stripe path is
// unchanged by OI-233 and is tracked separately.
async function updatePaymentByIntent(
  db: Db,
  pi: Stripe.PaymentIntent,
  eventType: string,
  patch: PaymentPatch,
  opts: { onlyWhenStatus?: string; quietOnNoMatch?: boolean } = {},
): Promise<void> {
  let direct = db.from('payments').update(patch).eq('stripe_payment_intent_id', pi.id)
  if (opts.onlyWhenStatus) direct = direct.eq('stripe_status', opts.onlyWhenStatus)
  const { data: matched, error } = await direct.select('id')
  if (error) throw new Error(`DB update failed: ${error.message}`)
  if (matched && matched.length > 0) return

  const clientRequestId = pi.metadata?.client_request_id
  if (!clientRequestId) return

  const { data: fallback, error: fallbackError } = await db.from('payments')
    .update({ ...patch, stripe_payment_intent_id: pi.id })
    .eq('client_request_id', clientRequestId)
    .is('stripe_payment_intent_id', null)
    .select('id')
  if (fallbackError) throw new Error(`DB update failed: ${fallbackError.message}`)
  if ((!fallback || fallback.length === 0) && !opts.quietOnNoMatch) {
    console.warn(`[ORA PM][OI-233] ${eventType} for ${pi.id} matched no payments row by PI id or client_request_id=${clientRequestId}`)
  }
}

export async function handleStripeEvent(
  event: Stripe.Event,
  db: Db
): Promise<void> {
  switch (event.type) {
    // ACH: Stripe emits this right after confirm, days before succeeded — the
    // earliest point the webhook can complete a write-back the route failed
    // to make. Only advances a row that is still 'pending' (Stripe does not
    // guarantee event ordering; a late 'processing' must never regress a
    // 'succeeded'/'failed' row). A zero-match here is the NORMAL case when
    // the route's own write-back already set 'processing', so it is quiet.
    case 'payment_intent.processing': {
      const pi = event.data.object as Stripe.PaymentIntent
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'processing' }, { onlyWhenStatus: 'pending', quietOnNoMatch: true })
      break
    }

    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'succeeded' })
      break
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      const reason = pi.last_payment_error?.message ?? 'Payment failed'
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'failed', notes: `Failed: ${reason}` })
      break
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'failed', notes: 'Payment canceled' })
      break
    }

    case 'charge.failed': {
      const charge = event.data.object as Stripe.Charge
      const id = piId(charge.payment_intent)
      if (!id) break
      const failureCode = charge.failure_code ?? 'unknown'
      const failureMsg = charge.failure_message ?? 'ACH return'
      const { error } = await db.from('payments')
        .update({
          stripe_status: 'returned',
          notes: `ACH return — ${failureCode}: ${failureMsg}`,
        })
        .eq('stripe_payment_intent_id', id)
        .select('id')
      if (error) throw new Error(`DB update failed: ${error.message}`)
      break
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute
      const id = piId(dispute.payment_intent)
      if (!id) break
      const { error } = await db.from('payments')
        .update({ stripe_status: 'failed', notes: `Dispute created: ${dispute.reason ?? 'unknown'}` })
        .eq('stripe_payment_intent_id', id)
        .select('id')
      if (error) throw new Error(`DB update failed: ${error.message}`)
      break
    }

    default:
      break
  }
}
