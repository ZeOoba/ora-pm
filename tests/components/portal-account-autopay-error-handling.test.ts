import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-081 REFUTE follow-up: toggleAutopay previously had no catch block, so
// requireAal2's new 403 for an unenrolled tenant (the fix this test's sibling
// suite closes — see tests/routes/portal-autopay-aal-integration.test.ts)
// surfaced as a silent unhandled promise rejection instead of a visible
// error. Source-text check, same pattern as portal-login-shouldcreateuser.test.ts
// (no jsdom/React-rendering harness in this repo).
describe('PortalAccount — toggleAutopay surfaces errors instead of swallowing them (OI-081 follow-up)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalAccount.tsx'),
    'utf-8'
  )

  it('has a catch block on toggleAutopay that captures the error message', () => {
    expect(source).toMatch(
      /async function toggleAutopay[\s\S]*?catch\s*\(\s*err\s*\)\s*\{[\s\S]*?err as Error\)\.message/
    )
  })

  it('renders the captured autopay error near the toggle', () => {
    expect(source).toMatch(/autopayError\[lease\.id\]/)
  })
})
