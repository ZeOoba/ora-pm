import Stripe from 'stripe'

// CF Workers does not have Node's http module — must use fetch client.
export function getStripe(secretKey: string): Stripe {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required')
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  })
}
