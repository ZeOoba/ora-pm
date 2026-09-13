import type { Stripe } from '@stripe/stripe-js'
import { PortalApiError, type portalApi } from './portal-api'

export const PAYMENT_MAY_BE_PROCESSING_MSG =
  'This payment may already be processing — check your payment history before retrying.'

export function isIdempotencyError(err: unknown): boolean {
  return err instanceof Error && /idempoten/i.test(err.message)
}

// True when we cannot rule out that the charge actually reached Stripe: a
// network-level failure (fetch itself rejected — no HTTP response at all,
// surfaces as a bare Error/TypeError, never a PortalApiError) or a server
// 5xx (failed during or after the Stripe call; outcome unknown). A
// deterministic 4xx from the server's own PRE-Stripe gates — the rate limit
// at stripe.ts:120, the balance/amount checks at :135-168 — means the charge
// never reached Stripe at all: retrying is unambiguously safe there, and
// softening the message on one of those would be actively misleading (e.g.
// telling a rate-limited tenant their payment "may already be processing").
export function isIndeterminateFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (!(err instanceof PortalApiError)) return true
  return err.status >= 500
}

export interface PayAttemptTenant {
  id: string
  name: string
}

export interface PayAttemptInput {
  tenant: PayAttemptTenant
  leaseId: string
  amountCents: number
  description: string
  clientRequestId: string
}

export interface PayAttemptDeps {
  stripe: Pick<Stripe, 'collectBankAccountForSetup' | 'confirmUsBankAccountSetup'>
  api: Pick<typeof portalApi, 'createSetupIntent' | 'createPaymentIntent'>
}

async function linkBankAccount(deps: PayAttemptDeps, tenant: PayAttemptTenant): Promise<string> {
  const { client_secret } = await deps.api.createSetupIntent(tenant.id)

  const { setupIntent, error: setupErr } = await deps.stripe.collectBankAccountForSetup({
    clientSecret: client_secret,
    params: {
      payment_method_type: 'us_bank_account',
      payment_method_data: { billing_details: { name: tenant.name } },
    },
  })
  if (setupErr) throw new Error(setupErr.message)
  if (!setupIntent?.payment_method) throw new Error('No payment method returned')

  const { error: confirmErr } = await deps.stripe.confirmUsBankAccountSetup(client_secret)
  if (confirmErr) throw new Error(confirmErr.message)

  return typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : setupIntent.payment_method.id
}

// OI-064: links a bank account only on the FIRST attempt for a given client_request_id, then reuses
// the resulting payment_method_id on every retry (network drop, server 5xx, etc). Before this, every
// Pay click re-ran the full link sequence, minting a NEW payment_method_id each time — so a retry
// sent the same client_request_id (the server's Stripe idempotency-key input) paired with DIFFERENT
// params. Stripe's idempotency layer treats a reused key + changed params as a mismatch and throws
// IdempotencyError instead of returning the original PaymentIntent, which surfaced as a bare "payment
// failed" for a payment that may have actually succeeded server-side, with no safe way for the tenant
// to tell — an operational double-payment risk (mailing a check for a charge that already cleared).
export async function runPayAttempt(
  deps: PayAttemptDeps,
  input: PayAttemptInput,
  paymentMethodIdRef: { current: string | null }
): Promise<{ payment_intent_id?: string; status?: string; deduped?: boolean }> {
  if (!paymentMethodIdRef.current) {
    paymentMethodIdRef.current = await linkBankAccount(deps, input.tenant)
  }

  try {
    return await deps.api.createPaymentIntent({
      tenant_id: input.tenant.id,
      lease_id: input.leaseId,
      amount_cents: input.amountCents,
      payment_method_id: paymentMethodIdRef.current,
      description: input.description,
      client_request_id: input.clientRequestId,
    })
  } catch (err) {
    // Soften only when we genuinely cannot tell whether the charge went through: an idempotency-
    // shaped rejection (Stripe saw this key before — note this is NOT the same as the ~24h key
    // window expiring; an EXPIRED key mints a silent second PaymentIntent instead of erroring, a
    // double-charge risk this check cannot catch), or an indeterminate network/5xx failure. A
    // deterministic 4xx (rate limit, balance cap, validation) means the charge never happened —
    // showing the raw reason is correct and never misleading there, retry or not.
    if (isIdempotencyError(err) || isIndeterminateFailure(err)) {
      throw new Error(`${PAYMENT_MAY_BE_PROCESSING_MSG} (${(err as Error).message})`)
    }
    throw err
  }
}
