import Stripe from 'stripe'

// CF Workers does not have Node's http module — must use fetch client.
//
// maxNetworkRetries: 1 (OI-162/#1 round 3, 2026-08-16) — stripe-node v22 defaults to 2
// (validateInteger('maxNetworkRetries', props.maxNetworkRetries, 2) in stripe.core.js), meaning
// up to 3 attempts per call with no explicit config. Every Stripe call in this codebase
// (monthly-billing's autopay debit) already carries a deterministic idempotencyKey, so a retry
// never risks a double charge — but each retry IS a Cloudflare Workers subrequest, and
// monthly-billing's per-invocation subrequest budget is sized against a worst case that assumes
// this number. Pinned explicitly so that worst case is documented and bounded, not left to the
// SDK's own default.
export function getStripe(secretKey: string): Stripe {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required')
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 1,
  })
}
