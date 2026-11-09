import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-065/223/233 review follow-up: migration 0014's reserve_payment_intent()
// writes payments.stripe_status = 'pending' before Stripe is even called, and
// a row can sit in that state for a while (write-back failure, awaiting the
// webhook). Before this, 'pending' had no entry in STATUS_BADGE and fell
// through to a generic untitled gray badge — not broken, but visually
// inconsistent with every other status. No React-rendering harness exists in
// this repo (see portal-paynow-client-request-id.test.ts), so this reads the
// component source directly, matching that established pattern.
describe('PortalPaymentHistory — STATUS_BADGE covers pending (OI-065/223/233 follow-up)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalPaymentHistory.tsx'),
    'utf-8'
  )

  it('has a pending entry in STATUS_BADGE', () => {
    expect(source).toMatch(/pending:\s*'bg-[^']+'/)
  })

  it('gives pending the same treatment as processing (both mean "not yet settled")', () => {
    const processing = source.match(/processing:\s*'([^']+)'/)?.[1]
    const pending = source.match(/pending:\s*'([^']+)'/)?.[1]
    expect(processing).toBeTruthy()
    expect(pending).toBe(processing)
  })
})

// E9 (2026-11-08): charge.dispute.created now writes stripe_status = 'disputed' (it used to write
// 'failed'). The payment is uncredited while the dispute is open and may be restored if it is
// won, so it gets the "not yet settled" treatment, not the generic gray fallback.
describe('PortalPaymentHistory — STATUS_BADGE covers disputed (E9)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalPaymentHistory.tsx'),
    'utf-8'
  )

  it('gives disputed the same treatment as processing', () => {
    const processing = source.match(/processing:\s*'([^']+)'/)?.[1]
    const disputed = source.match(/disputed:\s*'([^']+)'/)?.[1]
    expect(processing).toBeTruthy()
    expect(disputed).toBe(processing)
  })
})
