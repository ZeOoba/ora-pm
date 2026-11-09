import type Stripe from 'stripe'
import type { getDb } from '../db/client'

type Db = ReturnType<typeof getDb>
type PaymentPatch = Record<string, string | null>

// ---------------------------------------------------------------------------
// Allowed-transition table (audit finding webhook-succeeded-regresses-terminal-status).
//
// Stripe does not guarantee event ORDER and re-delivers on any non-2xx, so every UPDATE below is a
// compare-and-swap: it only applies when the row's CURRENT stripe_status is in the event's
// allowed-from set (`.in('stripe_status', ALLOWED_FROM[transition])`, evaluated atomically by
// Postgres in the UPDATE's WHERE clause). A late or replayed event against a row that has already
// moved on matches zero rows and is a no-op.
//
// Rules:
//   - Terminal states never regress: failed (payment_failed / canceled / dispute), returned (ACH
//     return), and canceled (a raw PI status cron.ts's autopay insert can store) are in NO
//     allowed-from set.
//   - succeeded is final for the PaymentIntent lifecycle events (a stale payment_failed, canceled or
//     processing cannot undo it). ONLY an ACH return (charge.failed) or a dispute may override it,
//     because both mean the money did not stay collected.
//   - processing only advances a 'pending' reservation row (unchanged from OI-233).
// Stored values are unchanged: canceled and dispute still write 'failed' (distinguished by notes),
// so ar_ledger, reserve_payment_intent (0014) and stripe.ts's terminal check are unaffected.
// ---------------------------------------------------------------------------

/** Non-terminal statuses a payments row can hold: the reservation/webhook values plus the raw
 *  PaymentIntent statuses cron.ts's autopay insert stores verbatim (`stripe_status: pi.status`). */
export const IN_FLIGHT_STATUSES = [
  'pending',
  'processing',
  'requires_payment_method',
  'requires_action',
  'requires_confirmation',
  'requires_capture',
] as const

/** Statuses no webhook event may move a row out of. */
export const TERMINAL_STATUSES = ['failed', 'returned', 'canceled'] as const

export type StripeTransition = 'processing' | 'succeeded' | 'payment_failed' | 'canceled' | 'returned' | 'disputed'

export const ALLOWED_FROM: Readonly<Record<StripeTransition, readonly string[]>> = {
  processing: ['pending'],
  succeeded: IN_FLIGHT_STATUSES,
  payment_failed: IN_FLIGHT_STATUSES,
  canceled: IN_FLIGHT_STATUSES,
  returned: [...IN_FLIGHT_STATUSES, 'succeeded'],
  disputed: [...IN_FLIGHT_STATUSES, 'succeeded'],
}

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
// calling Stripe (its post-Stripe UPDATE failed — OI-233), OR the row's
// current status does not permit this transition (ALLOWED_FROM above). In the
// first case the row still exists, keyed by the client_request_id the route
// also stamped into the PaymentIntent's metadata, with
// stripe_payment_intent_id NULL. Complete the write-back here: set the PI id
// together with the status this event carries. The `IS NULL` guard means a
// row that was written back after all (a race with a late route retry) is
// never overwritten twice, and the same allowed-from guard applies, so a
// reservation already released as 'failed' is never revived.
//
// PIs with no client_request_id in metadata (cron.ts autopay debits) have
// no reservation row to fall back to — their insert-after-Stripe path is
// unchanged by OI-233 and is tracked separately.
async function updatePaymentByIntent(
  db: Db,
  pi: Stripe.PaymentIntent,
  eventType: string,
  patch: PaymentPatch,
  transition: StripeTransition,
  opts: { quietOnNoMatch?: boolean } = {},
): Promise<void> {
  const allowedFrom = ALLOWED_FROM[transition]
  const { data: matched, error } = await db.from('payments')
    .update(patch)
    .eq('stripe_payment_intent_id', pi.id)
    .in('stripe_status', allowedFrom)
    .select('id')
  if (error) throw new Error(`DB update failed: ${error.message}`)
  if (matched && matched.length > 0) return

  const clientRequestId = pi.metadata?.client_request_id
  if (!clientRequestId) return

  const { data: fallback, error: fallbackError } = await db.from('payments')
    .update({ ...patch, stripe_payment_intent_id: pi.id })
    .eq('client_request_id', clientRequestId)
    .is('stripe_payment_intent_id', null)
    .in('stripe_status', allowedFrom)
    .select('id')
  if (fallbackError) throw new Error(`DB update failed: ${fallbackError.message}`)
  if ((!fallback || fallback.length === 0) && !opts.quietOnNoMatch) {
    // Also the expected outcome of a late/replayed event against a row whose status no longer
    // permits this transition (ALLOWED_FROM) — not necessarily a missing row.
    console.warn(`[ORA PM][OI-233] ${eventType} for ${pi.id} matched no payments row by PI id or client_request_id=${clientRequestId} in an allowed-from status (${allowedFrom.join(',')})`)
  }
}

// Guarded UPDATE by PI id for the charge-level events (ACH return, dispute). No client_request_id
// fallback: a Charge/Dispute carries no PI metadata, and both only arrive after a PI exists.
async function updatePaymentByPiIdGuarded(db: Db, id: string, patch: PaymentPatch, transition: StripeTransition): Promise<void> {
  const { error } = await db.from('payments')
    .update(patch)
    .eq('stripe_payment_intent_id', id)
    .in('stripe_status', ALLOWED_FROM[transition])
    .select('id')
  if (error) throw new Error(`DB update failed: ${error.message}`)
}

export async function handleStripeEvent(
  event: Stripe.Event,
  db: Db
): Promise<void> {
  // Every case is ordering-guarded by ALLOWED_FROM (top of file).
  switch (event.type) {
    // ACH: Stripe emits this right after confirm, days before succeeded — the
    // earliest point the webhook can complete a write-back the route failed
    // to make. Only advances a row that is still 'pending' (Stripe does not
    // guarantee event ordering; a late 'processing' must never regress a
    // 'succeeded'/'failed' row). A zero-match here is the NORMAL case when
    // the route's own write-back already set 'processing', so it is quiet.
    case 'payment_intent.processing': {
      const pi = event.data.object as Stripe.PaymentIntent
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'processing' }, 'processing', { quietOnNoMatch: true })
      break
    }

    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'succeeded' }, 'succeeded')
      break
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      const reason = pi.last_payment_error?.message ?? 'Payment failed'
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'failed', notes: `Failed: ${reason}` }, 'payment_failed')
      break
    }

    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent
      await updatePaymentByIntent(db, pi, event.type, { stripe_status: 'failed', notes: 'Payment canceled' }, 'canceled')
      break
    }

    case 'charge.failed': {
      const charge = event.data.object as Stripe.Charge
      const id = piId(charge.payment_intent)
      if (!id) break
      const failureCode = charge.failure_code ?? 'unknown'
      const failureMsg = charge.failure_message ?? 'ACH return'
      await updatePaymentByPiIdGuarded(db, id, {
        stripe_status: 'returned',
        notes: `ACH return — ${failureCode}: ${failureMsg}`,
      }, 'returned')
      break
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute
      const id = piId(dispute.payment_intent)
      if (!id) break
      await updatePaymentByPiIdGuarded(db, id, { stripe_status: 'failed', notes: `Dispute created: ${dispute.reason ?? 'unknown'}` }, 'disputed')
      break
    }

    default:
      break
  }
}
