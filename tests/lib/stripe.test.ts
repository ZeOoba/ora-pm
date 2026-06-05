import { describe, it, expect } from 'vitest'
import { getStripe } from '../../server/lib/stripe'

describe('getStripe', () => {
  it('returns a Stripe instance with fetch http client', () => {
    const stripe = getStripe('sk_test_dummy')
    expect(stripe).toBeDefined()
    expect(typeof stripe.paymentIntents.create).toBe('function')
  })

  it('throws if secret key is empty', () => {
    expect(() => getStripe('')).toThrow()
  })
})
