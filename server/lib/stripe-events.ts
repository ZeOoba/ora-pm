import type Stripe from 'stripe'
import type { getDb } from '../db/client'

export async function handleStripeEvent(
  event: Stripe.Event,
  db: ReturnType<typeof getDb>
): Promise<void> {
  // Stub — fully implemented in T7
  void event
  void db
}
