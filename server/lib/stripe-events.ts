import type Stripe from 'stripe'
import type { getDb } from '../db/client'

export async function handleStripeEvent(
  event: Stripe.Event,
  db: ReturnType<typeof getDb>
): Promise<void> {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      await db.from('payments')
        .update({ stripe_status: 'succeeded' })
        .eq('stripe_payment_intent_id', pi.id)
      break
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      const reason = pi.last_payment_error?.message ?? 'Payment failed'
      await db.from('payments')
        .update({ stripe_status: 'failed', notes: `Failed: ${reason}` })
        .eq('stripe_payment_intent_id', pi.id)
      break
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent
      await db.from('payments')
        .update({ stripe_status: 'failed', notes: 'Payment canceled' })
        .eq('stripe_payment_intent_id', pi.id)
      break
    }

    case 'charge.failed': {
      const charge = event.data.object as Stripe.Charge
      if (!charge.payment_intent) break
      const failureCode = charge.failure_code ?? 'unknown'
      const failureMsg = charge.failure_message ?? 'ACH return'
      await db.from('payments')
        .update({
          stripe_status: 'returned',
          notes: `ACH return — ${failureCode}: ${failureMsg}`,
        })
        .eq('stripe_payment_intent_id', charge.payment_intent as string)
      break
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute
      if (!dispute.payment_intent) break
      await db.from('payments')
        .update({ stripe_status: 'failed', notes: `Dispute created: ${dispute.reason}` })
        .eq('stripe_payment_intent_id', dispute.payment_intent as string)
      break
    }

    default:
      break
  }
}
