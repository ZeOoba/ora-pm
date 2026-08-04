import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAal2Guard } from '../../src/portal/lib/mfa-guard'

// OI-045: PortalAccount's "Set up two-factor authentication" button previously called
// `mfa.enroll()` and discarded the result -- no `mfa.challenge`/`mfa.verify` call existed
// anywhere in the repo, so enrollment could never complete, and every click left another
// orphaned unverified factor sitting in Supabase auth. No React-rendering test harness
// exists in this repo -- no jsdom environment, no @testing-library/react (see
// vitest.config.ts's `environment: 'node'` and package.json's devDependencies) -- so,
// matching the established pattern in this repo (admin-login-shouldcreateuser.test.ts,
// portal-charge-field-drift.test.ts, portal-paynow-client-request-id.test.ts), the
// enroll/challenge/verify/cleanup flow is verified by reading the component source
// directly rather than mounting it. The AAL2 guard (RED 4) is a genuine pure function
// with no rendering involved, so it's tested by calling it directly.
describe('PortalAccount MFA enrollment modal (OI-045)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalAccount.tsx'),
    'utf-8'
  )

  it('RED 1: enrolls a TOTP factor and renders the returned QR code and manual-entry secret', () => {
    expect(source).toMatch(/mfa\.enroll\(\{\s*\n?\s*factorType:\s*'totp'/)
    // QR code rendered from the SVG data URI (totp.qr_code is raw SVG markup, not
    // itself a data URI -- per @supabase/auth-js's AuthMFAEnrollTOTPResponse doc,
    // the caller must prepend the data:image/svg+xml;utf-8, prefix).
    expect(source).toMatch(/data:image\/svg\+xml;utf-8,\$\{enrollment\.qrCode\}/)
    // manual-entry fallback secret is rendered somewhere in the enrollment step
    expect(source).toMatch(/\{enrollment\.secret\}/)
  })

  it('RED 2: on submit, challenges the factor then verifies the entered code against the resulting challengeId', () => {
    expect(source).toMatch(/mfa\.challenge\(\{\s*factorId:\s*enrollment\.factorId,?\s*\}\)/)
    expect(source).toMatch(
      /mfa\.verify\(\{\s*factorId:\s*enrollment\.factorId,\s*challengeId:\s*challengeData\.id,\s*code,?\s*\}\)/
    )
    // verify must not fire before challenge resolves
    const challengeIdx = source.indexOf('mfa.challenge(')
    const verifyIdx = source.indexOf('mfa.verify(')
    expect(challengeIdx).toBeGreaterThan(-1)
    expect(verifyIdx).toBeGreaterThan(challengeIdx)
  })

  it('RED 3: on modal open, unenrolls any factor still in "unverified" status (orphan cleanup)', () => {
    expect(source).toMatch(/function loadFactors/)
    // the cleanup filter + unenroll call must live inside loadFactors, the function
    // the modal-open handler calls
    const loadFactorsBody = source.slice(source.indexOf('function loadFactors'))
    expect(loadFactorsBody).toMatch(/status\s*===\s*'unverified'/)
    expect(loadFactorsBody).toMatch(/mfa\.unenroll\(\{\s*\n?\s*factorId:\s*f\.id\s*\n?\s*\}\)/)
    expect(source).toMatch(/function openMfaModal[\s\S]*?loadFactors\(\)/)
  })

  it('lists currently-verified factors with an unenroll option', () => {
    expect(source).toMatch(/mfa\.listFactors\(\)/)
    expect(source).toMatch(/status\s*===\s*'verified'/)
    expect(source).toMatch(/function removeFactor/)
    expect(source).toMatch(/mfa\.unenroll\(\{\s*\n?\s*factorId\s*\n?\s*\}\)/)
  })

  it('does not leave the old fire-and-forget handleMFA in place', () => {
    expect(source).not.toMatch(/function handleMFA/)
  })
})

describe('checkAal2Guard — pure AAL2 decision function (OI-045, RED 4)', () => {
  it('RED 4a: returns "challenge required" when currentLevel is aal1 but a verified factor makes aal2 reachable', () => {
    expect(checkAal2Guard({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe('challenge required')
  })

  it('RED 4b: returns "session OK" once currentLevel is already aal2', () => {
    expect(checkAal2Guard({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe('session OK')
  })

  it('is a no-op for a tenant with no verified factor (nextLevel never exceeds currentLevel)', () => {
    expect(checkAal2Guard({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe('session OK')
  })

  it('is a no-op before any session exists (both levels null)', () => {
    expect(checkAal2Guard({ currentLevel: null, nextLevel: null })).toBe('session OK')
  })
})

describe('PortalApp — AAL2 guard call site (OI-045)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/PortalApp.tsx'),
    'utf-8'
  )

  it('checks the authenticator assurance level once a session exists and feeds it through the pure guard', () => {
    expect(source).toMatch(/import\s*\{\s*checkAal2Guard[\s\S]*?\}\s*from\s*['"]\.\/lib\/mfa-guard['"]/)
    expect(source).toMatch(/getAuthenticatorAssuranceLevel\(\)/)
    expect(source).toMatch(/checkAal2Guard\(/)
  })

  it('renders an MFA challenge screen instead of the router when the guard requires one', () => {
    expect(source).toMatch(/import\s*\{\s*PortalMfaChallenge\s*\}\s*from\s*['"]\.\/components\/PortalMfaChallenge['"]/)
    expect(source).toMatch(/'challenge required'/)
    expect(source).toMatch(/<PortalMfaChallenge/)
  })
})
