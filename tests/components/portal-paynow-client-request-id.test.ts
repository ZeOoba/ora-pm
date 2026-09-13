import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-035 route half: the server's idempotency key (pi:<tenantId>:<client_request_id>)
// only protects a retry if the CLIENT sends the same client_request_id verbatim on
// that retry. No React-rendering test harness exists in this repo (see
// portal-charge-field-drift.test.ts), so — matching that file's established pattern —
// this reads the component source directly rather than mounting it.
describe('PortalPayNow — client_request_id generation (OI-035)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalPayNow.tsx'),
    'utf-8'
  )
  const apiSource = readFileSync(
    join(__dirname, '../../src/portal/lib/portal-api.ts'),
    'utf-8'
  )

  it('generates the id with crypto.randomUUID()', () => {
    expect(source).toMatch(/crypto\.randomUUID\(\)/)
  })

  it('does NOT call crypto.randomUUID() directly in the component body (would re-generate on every render)', () => {
    // The only call site must be inside a ref-guarded assignment
    // (`if (!ref.current) ref.current = crypto.randomUUID()`), never a bare
    // `useState(crypto.randomUUID())` or a top-level `const x = crypto.randomUUID()`
    // that runs fresh on every render.
    expect(source).toMatch(/if\s*\(!clientRequestIdRef\.current\)\s*clientRequestIdRef\.current\s*=\s*crypto\.randomUUID\(\)/)
  })

  it('stores the id in a ref, not state (a state write would re-render and could race)', () => {
    expect(source).toMatch(/useRef<string \| null>\(null\)/)
  })

  it('resets the ref when the charge selection changes, so a genuinely different attempt gets a fresh id', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{\s*paymentMethodIdRef\.current = null\s*clientRequestIdRef\.current = null\s*\}, \[selected\]\)/)
  })

  it('resets the ref after a successful payment, so the next payment gets its own fresh id', () => {
    // Anchored tightly: the reset must be immediately (only whitespace/an
    // inline comment between) followed by setStep('done') — not just
    // satisfied by the earlier, unrelated useEffect(() => { ... }, [selected])
    // reset (which resets on charge-selection change, not payment success)
    // followed ANYWHERE later by the file's one setStep('done') call. This
    // would fail if the post-success reset line were deleted.
    expect(source).toMatch(/clientRequestIdRef\.current = null(?:[ \t]*\/\/[^\n]*)?\n\s*setStep\('done'\)/)
  })

  it('passes the id through to runPayAttempt as clientRequestId (verified end-to-end in portal-pay-attempt.test.ts)', () => {
    expect(source).toMatch(/clientRequestId:\s*clientRequestIdRef\.current/)
  })

  it('portal-api.ts requires client_request_id on the createPaymentIntent request body type', () => {
    expect(apiSource).toMatch(/createPaymentIntent:\s*\(body:\s*\{[\s\S]*?client_request_id:\s*string[\s\S]*?\}\)/)
  })
})

// OI-064: payment_method_id must be a first-class part of the same one-per-attempt unit as
// client_request_id — never reset independently, never re-derived on a retry. A drift between the
// two (e.g. a future edit resets one but not the other) silently reintroduces the idempotency-key/
// parameter mismatch this fix closes.
describe('PortalPayNow — payment_method_id persists across retries (OI-064)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalPayNow.tsx'),
    'utf-8'
  )

  it('declares paymentMethodIdRef as a ref, not state', () => {
    expect(source).toMatch(/const paymentMethodIdRef = useRef<string \| null>\(null\)/)
  })

  it('resets paymentMethodIdRef immediately before clientRequestIdRef on every reset site (pairing invariant)', () => {
    const pmResets = source.match(/paymentMethodIdRef\.current = null/g) ?? []
    const crResets = source.match(/clientRequestIdRef\.current = null/g) ?? []
    expect(pmResets.length).toBeGreaterThan(0)
    expect(pmResets.length).toBe(crResets.length)

    // Every clientRequestIdRef reset must be immediately preceded by a paymentMethodIdRef reset
    // (only whitespace/an inline comment between) — this is what makes the two structurally
    // impossible to drift apart, rather than merely coincidentally matching in count.
    const pairedPattern = /paymentMethodIdRef\.current = null\s*\n\s*clientRequestIdRef\.current = null/g
    const paired = source.match(pairedPattern) ?? []
    expect(paired.length).toBe(crResets.length)
  })

  it('does not call the Stripe bank-linking sequence directly — delegates to runPayAttempt', () => {
    expect(source).not.toMatch(/collectBankAccountForSetup/)
    expect(source).not.toMatch(/confirmUsBankAccountSetup/)
    expect(source).not.toMatch(/portalApi\.createSetupIntent/)
  })

  it('imports and calls runPayAttempt, passing paymentMethodIdRef through', () => {
    expect(source).toMatch(/import \{ runPayAttempt \} from '\.\.\/lib\/pay-attempt'/)
    expect(source).toMatch(/runPayAttempt\(\s*\{\s*stripe,\s*api:\s*portalApi\s*\},/)
    expect(source).toMatch(/paymentMethodIdRef\s*\)/)
  })
})
