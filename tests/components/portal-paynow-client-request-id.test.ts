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
    expect(source).toMatch(/useEffect\(\(\) => \{\s*clientRequestIdRef\.current = null\s*\}, \[selected\]\)/)
  })

  it('resets the ref after a successful payment, so the next payment gets its own fresh id', () => {
    expect(source).toMatch(/clientRequestIdRef\.current = null[\s\S]*setStep\('done'\)/)
  })

  it('sends client_request_id on the createPaymentIntent call', () => {
    expect(source).toMatch(/client_request_id:\s*clientRequestIdRef\.current/)
  })

  it('portal-api.ts requires client_request_id on the createPaymentIntent request body type', () => {
    expect(apiSource).toMatch(/createPaymentIntent:\s*\(body:\s*\{[\s\S]*?client_request_id:\s*string[\s\S]*?\}\)/)
  })
})
