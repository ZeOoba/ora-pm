import type Stripe from 'stripe'
import type { getDb } from '../db/client'

function piId(ref: string | Stripe.PaymentIntent | null): string | null {
  if (!ref) return null
  return typeof ref === 'string' ? ref : ref.id
}

export async function handleStripeEvent(
  event: Stripe.Event,
  db: ReturnType<typeof getDb>
): Promise<void> {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      const { error } = await db.from('payments')
        .update({ stripe_status: 'succeeded' })
        .eq('stripe_payment_intent_id', pi.id)
      if (error) throw new Error(`DB update failed: ${error.message}`)
      break
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      const reason = pi.last_payment_error?.message ?? 'Payment failed'
      const { error } = await db.from('payments')
        .update({ stripe_status: 'failed', notes: `Failed: ${reason}` })
        .eq('stripe_payment_intent_id', pi.id)
      if (error) throw new Error(`DB update failed: ${error.message}`)
      break
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent
      const { error } = await db.from('payments')
        .update({ stripe_status: 'failed', notes: 'Payment canceled' })
        .eq('stripe_payment_intent_id', pi.id)
      if (error) throw new Error(`DB update failed: ${error.message}`)
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
      if (error) throw new Error(`DB update failed: ${error.message}`)
      break
    }

    default:
      break
  }
}
