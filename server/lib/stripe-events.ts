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
//   - Terminal states never regress: failed (payment_failed / canceled / lost dispute), returned
//     (ACH return), and canceled (a raw PI status cron.ts's autopay insert can store) are in NO
//     allowed-from set.
//   - succeeded is final for the PaymentIntent lifecycle events (a stale payment_failed, canceled or
//     processing cannot undo it). ONLY an ACH return (charge.failed) or a dispute may override it,
//     because both mean the money did not stay collected.
//   - processing only advances a 'pending' reservation row (unchanged from OI-233).
//   - disputed (E9, 2026-11-08) is a holding state, not terminal: charge.dispute.created writes it
//     and only the dispute's own outcome moves the row on (charge.dispute.closed, E10): won /
//     warning_closed -> succeeded (from disputed only), lost -> failed (from disputed, succeeded or
//     in flight: a lost dispute means the money is gone whether or not dispute.created was ever
//     applied). LIMIT: like every charge-level event, a closed dispute is matched ONLY by
//     stripe_payment_intent_id. An OI-233 reservation row whose PI id was never written back
//     (NULL) is out of reach and a lost close leaves it as it is (logged as a zero match). A
//     later payment_intent.succeeded then credits that row via the client_request_id fallback,
//     so the lost payment is counted as paid until reconciled. A client_request_id fallback for
//     closed(lost), or a reconciliation flag, is a tracked follow-up.
//     An ACH return may also take it to returned (the money is gone either way, and
//     returned is terminal so a later "won" cannot credit it). No PaymentIntent lifecycle event
//     touches a disputed row.
//   - A dispute.created delivery is NOT replay-safe by compare-and-swap alone: after a won close
//     the row is 'succeeded' again, which dispute.created may move from. So dispute.created first
//     re-reads the dispute's LIVE status from Stripe and, if it has already closed, applies that
//     outcome instead of re-opening the row. This also covers closed-delivered-before-created.
//     KNOWN RACE (REFUTE N2, not closed by this): if a redelivered dispute.created reads the live
//     dispute while it is still open and a concurrent charge.dispute.closed (won/warning_closed)
//     then moves the row disputed -> succeeded before created writes, created's CAS (disputed is
//     allowed from succeeded) re-opens the won dispute. Fails safe (nothing wrongly credited) but
//     paid rent shows unpaid until fixed by hand, since the closed event is already 'processed'.
//     A lost close is immune (failed is not in disputed's allowed-from).
// What 'disputed' changes downstream: nothing in the money math. ar_ledger (0016) credits only
// stripe_status = 'succeeded', reserve_payment_intent (0014) counts only pending/processing as in
// flight, and cron.ts counts only succeeded ACH as paid, so a disputed payment is treated exactly
// as the 'failed' it used to be written as. There is no CHECK constraint on payments.stripe_status
// (0002), so no migration is needed. stripe.ts's same-client_request_id retry answers a disputed
// reservation with its recorded PI (deduped) instead of the 409 a 'failed' row gets; no Stripe call
// is made either way.
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

/** Written by charge.dispute.created; resolved by charge.dispute.closed (see header). */
export const DISPUTED_STATUS = 'disputed'

export type StripeTransition =
  | 'processing' | 'succeeded' | 'payment_failed' | 'canceled' | 'returned' | 'disputed'
  | 'dispute_won' | 'dispute_lost'

export const ALLOWED_FROM: Readonly<Record<StripeTransition, readonly string[]>> = {
  processing: ['pending'],
  succeeded: IN_FLIGHT_STATUSES,
  payment_failed: IN_FLIGHT_STATUSES,
  canceled: IN_FLIGHT_STATUSES,
  returned: [...IN_FLIGHT_STATUSES, 'succeeded', DISPUTED_STATUS],
  disputed: [...IN_FLIGHT_STATUSES, 'succeeded'],
  dispute_won: [DISPUTED_STATUS],
  dispute_lost: [DISPUTED_STATUS, 'succeeded', ...IN_FLIGHT_STATUSES],
}

/** The one Stripe read the handler needs: a dispute's live status (see header). */
export interface DisputeReader {
  disputes: { retrieve(id: string): Promise<{ status: string }> }
}

// charge.dispute.closed outcomes (Stripe Dispute.status once closed). warning_closed is an inquiry
// that closed without escalating: the funds were never withdrawn, so the payment stands.
const DISPUTE_CLOSED_OUTCOME: Readonly<Record<string, { transition: 'dispute_won' | 'dispute_lost'; stripe_status: string }>> = {
  won: { transition: 'dispute_won', stripe_status: 'succeeded' },
  warning_closed: { transition: 'dispute_won', stripe_status: 'succeeded' },
  lost: { transition: 'dispute_lost', stripe_status: 'failed' },
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
// cron.ts autopay debits reserve the same way since migration 0031
// (reserve_autopay_payment) and stamp the reservation's client_request_id into
// the PaymentIntent metadata, so this fallback completes their rows too. Only
// autopay PIs created before 0031 carry no client_request_id and have no
// reservation row to fall back to.
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
// Returns how many rows the compare-and-swap matched.
async function updatePaymentByPiIdGuarded(db: Db, id: string, patch: PaymentPatch, transition: StripeTransition): Promise<number> {
  const { data, error } = await db.from('payments')
    .update(patch)
    .eq('stripe_payment_intent_id', id)
    .in('stripe_status', ALLOWED_FROM[transition])
    .select('id')
  if (error) throw new Error(`DB update failed: ${error.message}`)
  return Array.isArray(data) ? data.length : 0
}

// Applies a CLOSED dispute's outcome. Returns false when `status` is not a closed outcome.
async function applyDisputeOutcome(db: Db, piIdValue: string, dispute: { id: string; status: string; reason?: string | null }, source: string): Promise<boolean> {
  const outcome = DISPUTE_CLOSED_OUTCOME[dispute.status]
  if (!outcome) return false
  const matched = await updatePaymentByPiIdGuarded(db, piIdValue, {
    stripe_status: outcome.stripe_status,
    notes: `Dispute ${dispute.status === 'lost' ? 'lost' : 'closed in our favor'} (${dispute.status}): ${dispute.reason ?? 'unknown'}`,
  }, outcome.transition)
  if (matched === 0) {
    // Normal on a replay, or for a won close of a row that is no longer 'disputed'. Otherwise the
    // row is not in an allowed-from state: e.g. it predates E9 and still holds 'failed' with
    // "Dispute created" notes, or it was already returned / failed.
    console.warn(`[ORA PM] ${source} ${dispute.id} (${dispute.status}) for ${piIdValue} matched no payments row in an allowed-from status (${ALLOWED_FROM[outcome.transition].join(',')})`)
  }
  return true
}

export async function handleStripeEvent(
  event: Stripe.Event,
  db: Db,
  stripe: DisputeReader,
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
      // REFUTE (E10): re-read the live status first. A redelivered dispute.created (E8's 500 on a
      // failed processed-write, Stripe's ~3-day retries, a dashboard "Resend") arriving after the
      // dispute was won would otherwise move the restored 'succeeded' row back to 'disputed'. A
      // retrieve failure throws -> 500 -> Stripe retries.
      const live = await stripe.disputes.retrieve(dispute.id)
      if (await applyDisputeOutcome(db, id, { id: dispute.id, status: live.status, reason: dispute.reason }, 'charge.dispute.created (already closed)')) break
      await updatePaymentByPiIdGuarded(db, id, { stripe_status: DISPUTED_STATUS, notes: `Dispute created: ${dispute.reason ?? 'unknown'}` }, 'disputed')
      break
    }

    // E10: resolve a disputed payment. Only a row currently 'disputed' moves (ALLOWED_FROM), so a
    // replay is a no-op and a row that never saw dispute.created, or already resolved, is untouched.
    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute
      const id = piId(dispute.payment_intent)
      if (!id) break
      if (!(await applyDisputeOutcome(db, id, dispute, 'charge.dispute.closed'))) {
        // Not a documented closed status. Log and acknowledge: throwing would only make Stripe
        // redeliver the same payload for days. The row stays as it is (a disputed row stays
        // uncredited, the safe side).
        console.warn(`[ORA PM] charge.dispute.closed ${dispute.id} for ${id}: unrecognized status '${dispute.status}'; payment left unchanged`)
      }
      break
    }

    default:
      break
  }
}
