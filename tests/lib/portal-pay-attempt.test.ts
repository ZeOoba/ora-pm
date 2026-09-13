import { describe, it, expect, vi } from 'vitest'

// portal-api.ts imports portalSupabase, whose module creates a real Supabase
// client at import time (needs VITE_SUPABASE_URL) — mocked here purely so
// importing PortalApiError (a plain class, no Supabase dependency of its
// own) doesn't drag that in, matching the established pattern in
// portal-insurance-rls-folder-key.test.ts.
vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: { auth: { getSession: vi.fn() } },
}))

import {
  runPayAttempt,
  isIdempotencyError,
  isIndeterminateFailure,
  PAYMENT_MAY_BE_PROCESSING_MSG,
  type PayAttemptDeps,
} from '../../src/portal/lib/pay-attempt'
import { PortalApiError } from '../../src/portal/lib/portal-api'

const tenant = { id: 'tenant-1', name: 'Acme Co' }

function makeDeps(overrides: Partial<{
  collectBankAccountForSetup: ReturnType<typeof vi.fn>
  confirmUsBankAccountSetup: ReturnType<typeof vi.fn>
  createSetupIntent: ReturnType<typeof vi.fn>
  createPaymentIntent: ReturnType<typeof vi.fn>
}> = {}): PayAttemptDeps & {
  stripe: { collectBankAccountForSetup: ReturnType<typeof vi.fn>; confirmUsBankAccountSetup: ReturnType<typeof vi.fn> }
  api: { createSetupIntent: ReturnType<typeof vi.fn>; createPaymentIntent: ReturnType<typeof vi.fn> }
} {
  return {
    stripe: {
      collectBankAccountForSetup:
        overrides.collectBankAccountForSetup ??
        vi.fn().mockResolvedValue({ setupIntent: { payment_method: 'pm_first' } }),
      confirmUsBankAccountSetup:
        overrides.confirmUsBankAccountSetup ?? vi.fn().mockResolvedValue({}),
    },
    api: {
      createSetupIntent:
        overrides.createSetupIntent ?? vi.fn().mockResolvedValue({ client_secret: 'seti_secret' }),
      createPaymentIntent:
        overrides.createPaymentIntent ??
        vi.fn().mockResolvedValue({ payment_intent_id: 'pi_1', status: 'processing' }),
    },
  } as unknown as PayAttemptDeps & {
    stripe: { collectBankAccountForSetup: ReturnType<typeof vi.fn>; confirmUsBankAccountSetup: ReturnType<typeof vi.fn> }
    api: { createSetupIntent: ReturnType<typeof vi.fn>; createPaymentIntent: ReturnType<typeof vi.fn> }
  }
}

const input = {
  tenant,
  leaseId: 'lease-1',
  amountCents: 150000,
  description: 'Rent payment — 1 charge(s)',
  clientRequestId: 'req-1',
}

describe('isIdempotencyError', () => {
  it('matches Stripe idempotency-error wording, case-insensitively', () => {
    expect(isIdempotencyError(new Error('Keys for idempotent requests can only be used with the same parameters'))).toBe(true)
    expect(isIdempotencyError(new Error('IDEMPOTENCY key reused'))).toBe(true)
  })

  it('does not match an unrelated error', () => {
    expect(isIdempotencyError(new Error('Your card was declined'))).toBe(false)
  })

  it('does not match a non-Error throwable', () => {
    expect(isIdempotencyError('idempotency string, not an Error instance')).toBe(false)
    expect(isIdempotencyError(undefined)).toBe(false)
  })
})

describe('isIndeterminateFailure', () => {
  it('is true for a network-level failure (no HTTP response — bare Error/TypeError, never a PortalApiError)', () => {
    expect(isIndeterminateFailure(new TypeError('Failed to fetch'))).toBe(true)
    expect(isIndeterminateFailure(new Error('Network request failed'))).toBe(true)
  })

  it('is true for a server 5xx (failed during/after the Stripe call — outcome unknown)', () => {
    expect(isIndeterminateFailure(new PortalApiError('Internal error', 500))).toBe(true)
    expect(isIndeterminateFailure(new PortalApiError('Bad gateway', 502))).toBe(true)
  })

  it('is false for a deterministic 4xx — the charge never reached Stripe', () => {
    expect(isIndeterminateFailure(new PortalApiError('Too many payment requests — retry in 42s', 429))).toBe(false)
    expect(isIndeterminateFailure(new PortalApiError('Amount exceeds outstanding balance', 422))).toBe(false)
    expect(isIndeterminateFailure(new PortalApiError('Your card was declined', 400))).toBe(false)
  })

  it('is false for a non-Error throwable', () => {
    expect(isIndeterminateFailure('boom')).toBe(false)
    expect(isIndeterminateFailure(undefined)).toBe(false)
  })
})

describe('runPayAttempt', () => {
  it('links a bank account and charges with the resulting payment_method_id on a first attempt', async () => {
    const deps = makeDeps()
    const ref = { current: null as string | null }

    const result = await runPayAttempt(deps, input, ref)

    expect(deps.api.createSetupIntent).toHaveBeenCalledTimes(1)
    expect(deps.stripe.collectBankAccountForSetup).toHaveBeenCalledTimes(1)
    expect(deps.stripe.confirmUsBankAccountSetup).toHaveBeenCalledTimes(1)
    expect(deps.api.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_id: 'pm_first', client_request_id: 'req-1' })
    )
    expect(ref.current).toBe('pm_first')
    expect(result.payment_intent_id).toBe('pi_1')
  })

  it('reuses the persisted payment_method_id on a retry instead of re-linking', async () => {
    const deps = makeDeps()
    const ref = { current: 'pm_from_first_attempt' as string | null }

    await runPayAttempt(deps, input, ref)

    expect(deps.api.createSetupIntent).not.toHaveBeenCalled()
    expect(deps.stripe.collectBankAccountForSetup).not.toHaveBeenCalled()
    expect(deps.stripe.confirmUsBankAccountSetup).not.toHaveBeenCalled()
    expect(deps.api.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_id: 'pm_from_first_attempt', client_request_id: 'req-1' })
    )
    // Same client_request_id + same payment_method_id on the retry — Stripe's idempotency key and
    // its params both match, so this returns the original PaymentIntent instead of throwing.
    expect(ref.current).toBe('pm_from_first_attempt')
  })

  it('a genuinely new attempt (ref cleared by the caller) re-links and gets a new payment_method_id', async () => {
    const deps = makeDeps({
      collectBankAccountForSetup: vi.fn().mockResolvedValue({ setupIntent: { payment_method: 'pm_second' } }),
    })
    const ref = { current: null as string | null }

    await runPayAttempt(deps, input, ref)

    expect(deps.api.createSetupIntent).toHaveBeenCalledTimes(1)
    expect(ref.current).toBe('pm_second')
  })

  it('on a retry, wraps a charge failure in the soft "may already be processing" message and keeps the ref', async () => {
    const deps = makeDeps({
      createPaymentIntent: vi.fn().mockRejectedValue(new Error('Network request failed')),
    })
    const ref = { current: 'pm_persisted' as string | null }

    await expect(runPayAttempt(deps, input, ref)).rejects.toThrow(PAYMENT_MAY_BE_PROCESSING_MSG)
    // The underlying detail is preserved for support triage, appended after the soft message.
    await expect(runPayAttempt(deps, input, ref)).rejects.toThrow(/Network request failed/)
    expect(ref.current).toBe('pm_persisted')
  })

  it('on a first attempt, an idempotency-shaped charge failure also gets the soft message', async () => {
    const deps = makeDeps({
      createPaymentIntent: vi
        .fn()
        .mockRejectedValue(new Error('Keys for idempotent requests can only be used with the same parameters')),
    })
    const ref = { current: null as string | null }

    await expect(runPayAttempt(deps, input, ref)).rejects.toThrow(PAYMENT_MAY_BE_PROCESSING_MSG)
  })

  it('a deterministic 4xx (rate limit, balance cap, validation) is NOT rewrapped — even on a retry, since the charge provably never reached Stripe', async () => {
    const deps = makeDeps({
      createPaymentIntent: vi.fn().mockRejectedValue(new PortalApiError('Too many payment requests — retry in 42s', 429)),
    })
    // Retry (ref already set) — the old isRetry-based logic would have wrongly softened this into
    // "may already be processing" for a rate-limited request that never reached Stripe.
    const ref = { current: 'pm_persisted' as string | null }

    let caught: Error | undefined
    try {
      await runPayAttempt(deps, input, ref)
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).toBe('Too many payment requests — retry in 42s')
    expect(caught?.message).not.toContain(PAYMENT_MAY_BE_PROCESSING_MSG)
  })

  it('on a first attempt, a server 5xx charge failure gets the soft message (outcome genuinely unknown)', async () => {
    const deps = makeDeps({
      createPaymentIntent: vi.fn().mockRejectedValue(new PortalApiError('Internal error', 500)),
    })
    const ref = { current: null as string | null }

    await expect(runPayAttempt(deps, input, ref)).rejects.toThrow(PAYMENT_MAY_BE_PROCESSING_MSG)
  })

  it('a bank-linking failure leaves the ref null and never attempts the charge', async () => {
    const deps = makeDeps({
      collectBankAccountForSetup: vi.fn().mockResolvedValue({ error: { message: 'Bank link failed' } }),
    })
    const ref = { current: null as string | null }

    await expect(runPayAttempt(deps, input, ref)).rejects.toThrow('Bank link failed')
    expect(ref.current).toBeNull()
    expect(deps.api.createPaymentIntent).not.toHaveBeenCalled()
  })
})
