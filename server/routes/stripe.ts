import { Hono } from 'hono'
import type { Context } from 'hono'
import Stripe from 'stripe'
import { getStripe } from '../lib/stripe'
import { getDb } from '../db/client'
import type { Env } from '../index'
import { tenantAuthMiddleware } from '../middleware/tenant-auth'
import { requireAal2 } from '../middleware/aal-guard'
import { checkRateLimit } from '../lib/rate-limit'
import { dbError } from '../lib/api-error'
import { PaymentIntentClientRequestIdSchema } from '../lib/schemas'

export const stripeRouter = new Hono<{ Bindings: Env }>()

// Existing payment-intent limit, unchanged by Task 6 — only checkRateLimit's
// internals (KV durability) and call signature (now async + config object)
// changed. See server/lib/rate-limit.ts.
const PAYMENT_INTENT_RATE_LIMIT = { scope: 'payment-intent', maxCalls: 5, windowMs: 60_000 }

// $50,000 — hard ceiling on a single ACH payment-intent request (OI-040).
// Independent of the outstanding-balance cap below; this bounds the blast
// radius of a single request regardless of what the lease happens to owe.
const MAX_PAYMENT_CENTS = 5_000_000

// Router-wide gate: any future stripe endpoint is tenant-authenticated by
// default (this router is in ADMIN_EXEMPT, so this is its only auth layer).
// The Stripe webhook lives on its own router (/api/webhooks) — not gated here.
stripeRouter.use('/*', tenantAuthMiddleware)

// POST /api/stripe/customer — create Stripe customer + store on tenant record
stripeRouter.post('/customer', async (c) => {
  const userId = c.get('tenantUserId')
  const { tenant_id, email, name } = await c.req.json()
  if (!tenant_id) return c.json({ error: 'tenant_id required' }, 400)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  // Resolve the AUTHENTICATED tenant and verify the request-body tenant_id
  // belongs to them (IDOR guard — OI-018)
  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id, stripe_customer_id').eq('auth_user_id', userId).single()
  if (tenantErr || !tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (tenant.id !== tenant_id) return c.json({ error: 'Forbidden' }, 403)
  if (tenant?.stripe_customer_id) {
    return c.json({ customer_id: tenant.stripe_customer_id })
  }

  let customer: Stripe.Customer
  try {
    customer = await stripe.customers.create({ email, name, metadata: { tenant_id: tenant.id } })
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) return c.json({ error: err.message }, 400)
    throw err
  }

  const { error: updateErr } = await db.from('tenants').update({ stripe_customer_id: customer.id }).eq('id', tenant.id)
  if (updateErr) return c.json({ error: 'Failed to save customer ID' }, 500)

  return c.json({ customer_id: customer.id })
})

// POST /api/stripe/setup-intent — create SetupIntent for Financial Connections bank linking
//
// OI-045: this is the endpoint that actually attaches a us_bank_account
// Stripe PaymentMethod to the tenant's customer — a REFUTE pass on the
// original /autopay-only fix found this ungated, meaning an attacker with a
// stolen aal1 JWT (no MFA step-up) could attach an arbitrary bank account
// here, then use it via /payment-intent below without ever needing MFA.
stripeRouter.post('/setup-intent', requireAal2, async (c) => {
  const userId = c.get('tenantUserId')
  const { tenant_id } = await c.req.json()
  if (!tenant_id) return c.json({ error: 'tenant_id required' }, 400)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  // Resolve the AUTHENTICATED tenant and verify the request-body tenant_id
  // belongs to them (IDOR guard — OI-018)
  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id, stripe_customer_id').eq('auth_user_id', userId).single()
  if (tenantErr || !tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (tenant.id !== tenant_id) return c.json({ error: 'Forbidden' }, 403)
  if (!tenant?.stripe_customer_id) return c.json({ error: 'No Stripe customer — call /customer first' }, 400)

  let setupIntent: Stripe.SetupIntent
  try {
    setupIntent = await stripe.setupIntents.create({
      customer: tenant.stripe_customer_id,
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ['payment_method'] },
          verification_method: 'instant',
        },
      },
    })
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) return c.json({ error: err.message }, 400)
    throw err
  }

  return c.json({ client_secret: setupIntent.client_secret })
})

// POST /api/stripe/payment-intent — create PaymentIntent for ACH charge
//
// OI-045: this endpoint CONFIRMS the PaymentIntent immediately (confirm:true
// below) — it is the one that actually moves money, making it the single
// most sensitive write path in this router. A stolen aal1 bearer JWT (e.g.
// via XSS or a synced session, without the tenant's MFA device) previously
// had no server-side barrier to initiating a real ACH debit here.
//
// OI-065 / OI-223 / OI-233: the ledger row is reserved BEFORE Stripe is
// called (reserve_payment_intent(), migration 0014) and completed after —
// see the reservation block below for the three defects that ordering closes.
stripeRouter.post('/payment-intent', requireAal2, async (c) => {
  const userId = c.get('tenantUserId')
  // CF-Connecting-IP is stamped by Cloudflare's edge and cannot be spoofed by
  // the client; X-Forwarded-For CAN be (OI-038, IP-handling slice), so it is
  // never used as a rate-limit key. Fall back to the authenticated tenant's
  // user id — not an absent-IP sentinel like 'unknown', which would let every
  // client missing the header share a single rate-limit bucket. This IP-vs-
  // fallback KEY DERIVATION is unchanged by Task 6 (KV-backed checkRateLimit
  // internals — see server/lib/rate-limit.ts); only the call below changed,
  // to the new async/KV-backed signature.
  const ip = c.req.header('CF-Connecting-IP') ?? userId
  const { allowed, retryAfterMs } = await checkRateLimit(c.env.RATE_LIMIT_KV, ip, PAYMENT_INTENT_RATE_LIMIT)
  if (!allowed) {
    return c.json(
      { error: `Too many payment requests — retry in ${Math.ceil(retryAfterMs / 1000)}s` },
      429
    )
  }

  const { tenant_id, lease_id, amount_cents, payment_method_id, description, client_request_id } = await c.req.json()
  if (!tenant_id || !lease_id || !amount_cents || !payment_method_id || !client_request_id) {
    return c.json({ error: 'tenant_id, lease_id, amount_cents, payment_method_id, client_request_id required' }, 400)
  }
  const clientRequestIdCheck = PaymentIntentClientRequestIdSchema.safeParse(client_request_id)
  if (!clientRequestIdCheck.success) return c.json({ error: 'client_request_id must be a valid UUID' }, 400)
  if (!Number.isInteger(amount_cents)) return c.json({ error: 'amount_cents must be an integer' }, 400)
  if (amount_cents < 50) return c.json({ error: 'Minimum payment is $0.50' }, 400)
  if (amount_cents > MAX_PAYMENT_CENTS) return c.json({ error: 'Amount exceeds maximum payment of $50,000' }, 422)

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY)
  const db = getDb(c.env)

  // Resolve the AUTHENTICATED tenant and verify the request-body tenant_id
  // belongs to them (IDOR guard — OI-018)
  const { data: tenant, error: tenantErr } = await db.from('tenants').select('id, stripe_customer_id').eq('auth_user_id', userId).single()
  if (tenantErr || !tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (tenant.id !== tenant_id) return c.json({ error: 'Forbidden' }, 403)
  if (!tenant?.stripe_customer_id) return c.json({ error: 'No Stripe customer' }, 400)

  // Verify this lease belongs to this tenant (IDOR guard) — before any Stripe
  // call, so a cross-tenant lease_id can never reach the charge or the
  // payments insert (same pattern as /portal/autopay)
  const { data: lease } = await db.from('leases').select('id, tenant_id').eq('id', lease_id).single()
  if (!lease || lease.tenant_id !== tenant.id) return c.json({ error: 'Lease not found' }, 404)

  // Reserve the ledger row BEFORE calling Stripe (OI-065 / OI-223 / OI-233).
  //
  // reserve_payment_intent() (supabase/migrations/0014_payment_intent_pending_row.sql)
  // does, in ONE transaction under a per-lease pg_advisory_xact_lock:
  //   1. same client_request_id already reserved → 'existing' (nothing written)
  //   2. ar_ledger.balance MINUS this lease's pending/processing ACH rows
  //      ('succeeded'-only ar_ledger cannot see money in flight — OI-223)
  //   3. amount cap (OI-040) against that pending-adjusted figure
  //   4. INSERT a 'pending' row (PI id NULL) keyed by client_request_id
  // The lock is what closes OI-065: a second concurrent request for the same
  // lease — same or different client_request_id — blocks until this one's
  // reservation is committed and then sees it in step 2. It has to be one
  // function: PostgREST gives each RPC its own transaction, so a lock taken
  // in a separate call would be gone before the balance read.
  // An RPC failure means the balance/reservation state is UNKNOWN — never a
  // blind allow, and Stripe is never called.
  const { data: reservationData, error: reserveErr } = await db.rpc('reserve_payment_intent', {
    p_lease_id: lease.id,
    p_client_request_id: client_request_id,
    p_amount_cents: amount_cents,
    p_notes: description ?? null,
  })
  if (reserveErr || !reservationData) {
    return dbError(c, reserveErr ?? { message: 'reserve_payment_intent returned no result' }, 'Failed to reserve payment')
  }
  const reservation = reservationData as Reservation

  // `resumed`: this request is completing a reservation an earlier attempt
  // with the same client_request_id left behind (see the 'existing' branch).
  let resumed = false
  switch (reservation.outcome) {
    case 'reserved':
      break

    case 'no_balance':
      return c.json({ error: 'No balance due' }, 422)

    case 'exceeds_balance': {
      const inFlightCents = reservation.in_flight_cents ?? 0
      // Say WHY when the reason is money already in flight — the tenant's
      // ledger view still shows the full balance owed until ACH settles.
      const error = inFlightCents > 0
        ? `Amount exceeds outstanding balance — a payment of ${formatUsd(inFlightCents)} is still processing`
        : 'Amount exceeds outstanding balance'
      return c.json({ error }, 422)
    }

    case 'existing': {
      // A reservation for this exact client_request_id already exists. What
      // that means depends on the state the earlier attempt left it in.
      if (reservation.stripe_status === 'failed' || reservation.stripe_status === 'returned') {
        // Terminal. Re-sending the same idempotency key to Stripe would only
        // replay the cached failure; the client must mint a new attempt.
        return c.json({ error: 'This payment attempt already failed — reload and start a new payment', failed: true }, 409)
      }
      if (reservation.stripe_payment_intent_id) {
        // The PI is recorded: this is a client retry after a response was
        // lost in transit (OI-035). Answer from the ledger — no Stripe call.
        return c.json({ payment_intent_id: reservation.stripe_payment_intent_id, status: reservation.stripe_status, deduped: true })
      }
      if (reservation.amount_cents !== amount_cents) {
        // Stripe binds the idempotency key to the original parameters and
        // would reject this anyway; fail before any call, with a clear reason.
        return c.json({ error: 'client_request_id was already used for a different amount — start a new payment' }, 409)
      }
      const ageSeconds = reservation.age_seconds ?? 0
      if (ageSeconds < IN_FLIGHT_WINDOW_SECONDS) {
        // The earlier attempt is (very probably) still between reserve and
        // write-back — a double-submit. Do NOT call Stripe: the original
        // request will write the PI back, or the webhook will.
        return c.json({ error: 'Payment already in progress — do not resubmit; check your payment history in a moment', in_progress: true }, 409)
      }
      if (ageSeconds >= STRIPE_IDEMPOTENCY_WINDOW_SECONDS) {
        // Past Stripe's idempotency window the same key could mint a SECOND
        // PaymentIntent if the first attempt's call did reach Stripe. Only a
        // human (or the reconciliation query in 0014) can resolve this safely.
        return c.json({ error: 'A previous attempt for this payment could not be confirmed and needs reconciliation — contact management before paying again', needs_reconciliation: true }, 409)
      }
      // Between the two windows: the earlier attempt died before writing the
      // PI back (or before ever reaching Stripe). Re-sending the SAME
      // idempotency key is safe — Stripe returns the original PaymentIntent
      // if one exists, otherwise creates the one and only — then write back
      // onto the SAME reservation row. No second reservation, no second debit.
      resumed = true
      break
    }

    default:
      console.error(`[ORA PM] reserve_payment_intent returned unknown outcome for client_request_id=${client_request_id}:`, reservation)
      return c.json({ error: 'Failed to reserve payment' }, 500)
  }

  let pi: Stripe.PaymentIntent
  try {
    pi = await stripe.paymentIntents.create({
      amount: amount_cents,
      currency: 'usd',
      customer: tenant.stripe_customer_id,
      payment_method: payment_method_id,
      payment_method_types: ['us_bank_account'],
      confirm: true,
      setup_future_usage: 'off_session' as const,
      description: description ?? `Rent payment — lease ${lease_id}`,
      // client_request_id in the PI's own metadata is what lets the webhook
      // (server/lib/stripe-events.ts) find the reservation row if the
      // write-back below never happens (OI-233).
      metadata: { lease_id: lease.id, tenant_id: tenant.id, client_request_id },
    }, {
      // Deterministic per tenant+client_request_id (OI-035 route half): a
      // client retry after a network timeout reuses the same client_request_id
      // verbatim, so Stripe returns the original PaymentIntent from its
      // idempotency cache instead of minting a second one. The resume path
      // above relies on exactly this.
      idempotencyKey: `pi:${tenant.id}:${client_request_id}`,
    })
  } catch (err) {
    return handleStripeCreateFailure(c, db, err, client_request_id)
  }

  // Write the PI id + status back onto the reservation (OI-233).
  //
  // Guarded to rows still pending/processing so a webhook that already
  // advanced this row (payment_intent.succeeded via the metadata fallback —
  // possible on the resume path, days later) is never regressed by the
  // status Stripe replays from its idempotency cache. .select('id') is what
  // makes a zero-match visible (data: [] — without it supabase-js returns
  // data: null either way).
  const { data: written, error: writeErr } = await db.from('payments')
    .update({ stripe_payment_intent_id: pi.id, stripe_status: pi.status })
    .eq('client_request_id', client_request_id)
    .in('stripe_status', ['pending', 'processing'])
    .select('id')
  if (writeErr) {
    // The debit is real and cannot be undone here. The reservation row —
    // 'pending', PI id NULL, correct lease/amount, keyed by client_request_id
    // — is the recoverable trace: the webhook completes it on the next
    // payment_intent.* event via metadata.client_request_id, and the
    // reconciliation query in 0014 finds anything that slips past that.
    // NOT a 500: the tenant must not be told the payment failed and pay
    // again out-of-band; they must learn the PI id so the client does not
    // resubmit as a new attempt.
    console.error(`[ORA PM][OI-233] ${pi.id} confirmed but ledger write-back failed for client_request_id=${client_request_id}:`, writeErr.code, writeErr.message)
    return c.json({ payment_intent_id: pi.id, status: pi.status, recorded: false, ...(resumed ? { resumed: true } : {}) })
  }
  if (!written || written.length === 0) {
    // No error but nothing matched: the row is no longer pending/processing,
    // i.e. the webhook already advanced it. The ledger is ahead of us, not
    // behind — nothing to recover.
    console.warn(`[ORA PM][OI-233] ${pi.id} write-back matched no pending/processing row for client_request_id=${client_request_id} (already advanced by webhook?)`)
  }

  return c.json({ payment_intent_id: pi.id, status: pi.status, ...(resumed ? { resumed: true } : {}) })
})

// Shape returned by reserve_payment_intent() — see the function's header
// comment in 0014_payment_intent_pending_row.sql for the per-outcome fields.
interface Reservation {
  outcome: 'reserved' | 'existing' | 'no_balance' | 'exceeds_balance'
  payment_id?: string
  stripe_payment_intent_id?: string | null
  stripe_status?: string | null
  amount_cents?: number
  age_seconds?: number
  outstanding_balance_cents?: number
  in_flight_cents?: number
  available_cents?: number
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// A pending reservation whose Stripe call is younger than this is treated as
// still in flight (double-submit) rather than abandoned. stripe-node's
// default request timeout is 80s; the write-back after it is one DB call.
const IN_FLIGHT_WINDOW_SECONDS = 120

// Stripe replays the original result for an idempotency key for ~24h. Past
// that, the same key would create a NEW PaymentIntent — so a reservation
// older than this can no longer be resumed safely.
const STRIPE_IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60

// Stripe error classes that mean the request was rejected WITHOUT creating
// a (charging) PaymentIntent. Everything else is indeterminate — the request
// may have reached Stripe — and the reservation must stay 'pending'.
const DEFINITIVE_STRIPE_FAILURES = [
  Stripe.errors.StripeInvalidRequestError,
  Stripe.errors.StripeCardError,
  Stripe.errors.StripeAuthenticationError,
  Stripe.errors.StripePermissionError,
  Stripe.errors.StripeRateLimitError,
]

// paymentIntents.create threw AFTER a reservation row was written (OI-233).
// What to do with that row depends on whether Stripe can have moved money.
async function handleStripeCreateFailure(
  c: Context<{ Bindings: Env }>,
  db: ReturnType<typeof getDb>,
  err: unknown,
  clientRequestId: string,
) {
  // Not a Stripe error at all (bug, OOM, ...): rethrow to Hono's 500, and
  // leave the reservation pending — the state is unknown.
  if (!(err instanceof Stripe.errors.StripeError)) throw err

  if (err instanceof Stripe.errors.StripeIdempotencyError) {
    // The same idempotency key is in flight on Stripe's side right now — a
    // duplicate that got past the reservation (e.g. a resume racing the
    // original attempt's slow call). That other call owns the write-back.
    return c.json({ error: 'Payment already in progress — do not resubmit', in_progress: true }, 409)
  }

  const definitive = DEFINITIVE_STRIPE_FAILURES.some((cls) => err instanceof cls)
  if (!definitive) {
    // StripeConnectionError / StripeAPIError (5xx) / anything unexpected:
    // the request may have been processed. The reservation stays 'pending'
    // and keeps counting against the balance (OI-223) until the webhook
    // completes it, a same-id retry resumes it (>= IN_FLIGHT_WINDOW), or a
    // human reconciles it. Refusing a possible double debit is the correct
    // failure direction here.
    console.error(`[ORA PM][OI-233] indeterminate Stripe failure for client_request_id=${clientRequestId}:`, err.type, err.message)
    return c.json({ error: 'Payment processor unreachable — do not resubmit; check your payment history in a few minutes', in_progress: true }, 502)
  }

  // Definitive rejection: nothing was debited. Release the reservation so it
  // stops counting against the balance. A card/bank error on a confirm:true
  // create can still leave a PaymentIntent behind (requires_payment_method,
  // never charged) — keep its id for the audit trail when Stripe returns it.
  // Guarded to 'pending' so a webhook that already resolved this row is not
  // overwritten. If the release itself fails the row stays 'pending' and is
  // conservatively treated as in flight (over-refuse, never over-debit).
  const piFromError = (err as { payment_intent?: { id?: string } }).payment_intent?.id ?? null
  const { error: releaseErr } = await db.from('payments')
    .update({ stripe_status: 'failed', stripe_payment_intent_id: piFromError, notes: `Stripe ${err.type}: ${err.message}` })
    .eq('client_request_id', clientRequestId)
    .eq('stripe_status', 'pending')
    .select('id')
  if (releaseErr) {
    console.error(`[ORA PM][OI-233] could not release reservation client_request_id=${clientRequestId} after definitive Stripe failure:`, releaseErr.code, releaseErr.message)
  }
  return c.json({ error: err.message }, 400)
}
