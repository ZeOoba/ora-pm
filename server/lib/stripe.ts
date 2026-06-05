import Stripe from 'stripe'

// CF Workers does not have Node's http module — must use fetch client.
export function getStripe(secretKey: string): Stripe {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required')
  return new Stripe(secretKey, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiVersion: '2024-06-20' as any,
    httpClient: Stripe.createFetchHttpClient(),
  })
}
