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

describe('PortalMfaChallenge — verified-factor filtering (review finding, post-effd6a3)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/components/PortalMfaChallenge.tsx'),
    'utf-8'
  )
  const accountSource = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalAccount.tsx'),
    'utf-8'
  )

  // Review finding (Important, post-effd6a3): `factorsData?.totp?.[0]` picked the
  // first TOTP factor with no status filter, unlike PortalAccount.tsx's loadFactors,
  // which explicitly filters `f.status === 'verified'`. A stale/orphaned unverified
  // factor sorted first (e.g. a second tab open mid-enrollment when this guard
  // screen fires) could target the wrong factorId for the actual security step-up
  // challenge. Must match PortalAccount's existing filter, not invent new logic.
  it('FIX 2: filters to status === "verified" before picking the factor to challenge, matching PortalAccount', () => {
    expect(accountSource).toMatch(/status\s*===\s*'verified'/)

    expect(source).toMatch(/status\s*===\s*'verified'/)
    // the unfiltered raw pick must be gone
    expect(source).not.toMatch(/factorsData\?\.totp\?\.\[0\]/)
    // the filter must run on factorsData.totp before the factor is used in the
    // challenge call
    const filterIdx = source.search(/status\s*===\s*'verified'/)
    const challengeIdx = source.indexOf('mfa.challenge(')
    expect(filterIdx).toBeGreaterThan(-1)
    expect(challengeIdx).toBeGreaterThan(filterIdx)
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

  // Review finding (Important, post-effd6a3): getAuthenticatorAssuranceLevel().then(...)
  // had no .catch() / try-catch, so a rejection (network blip, Supabase outage) left
  // aalStatus stuck at 'checking' forever -- an indefinite silent spinner for EVERY
  // tenant with a session, with no error, no retry, no way to proceed. Every other
  // async Supabase call in this diff (PortalAccount.tsx, PortalMfaChallenge.tsx) wraps
  // in try/catch with a surfaced error state; this call site must match that pattern.
  it('FIX 1: wraps the AAL check in error handling that sets a distinct error state', () => {
    // the effect body must catch a thrown/rejected error from the AAL check --
    // either an async function with try/catch, or a .catch() on the promise chain
    const usesTryCatch = /getAuthenticatorAssuranceLevel\(\)[\s\S]{0,800}\bcatch\b/.test(source)
    const usesPromiseCatch = /getAuthenticatorAssuranceLevel\(\)[\s\S]{0,200}\.catch\(/.test(source)
    expect(usesTryCatch || usesPromiseCatch).toBe(true)

    // the error path must set a status distinct from 'checking' (not just leave it
    // hanging), and that status must NOT be 'session OK' or 'challenge required'
    // literals reused to mean "error" -- it must be its own state.
    expect(source).toMatch(/setAalStatus\(\s*['"]error['"]\s*\)/)
  })

  it('FIX 1: the error state renders an actionable message and blocks the router (fails closed)', () => {
    // an error branch must exist that returns before falling through to <PortalRouter
    expect(source).toMatch(/aalStatus\s*===\s*['"]error['"]/)

    // the error branch's return block must come before the final `<PortalRouter`
    // fallthrough in source order, and must not itself render PortalRouter --
    // i.e. it's a distinct block, not merged into the router-rendering branch.
    const errorBranchIdx = source.indexOf("aalStatus === 'error'")
    const routerIdx = source.lastIndexOf('<PortalRouter')
    expect(errorBranchIdx).toBeGreaterThan(-1)
    expect(routerIdx).toBeGreaterThan(errorBranchIdx)

    // the block immediately following the error-branch check must not contain
    // <PortalRouter -- i.e. the error state renders its own UI, not the app.
    const errorBlock = source.slice(errorBranchIdx, errorBranchIdx + 400)
    const errorBlockReturn = errorBlock.slice(0, errorBlock.indexOf('\n\n') === -1 ? errorBlock.length : errorBlock.indexOf('\n\n'))
    expect(errorBlockReturn).not.toMatch(/<PortalRouter/)

    // actionable: a visible message and a retry affordance, styled consistent with
    // this diff's existing error UI (text-red-600, per PortalAccount/PortalMfaChallenge)
    expect(errorBlock).toMatch(/text-red-600/)
    expect(errorBlock).toMatch(/onClick/)
  })
})
