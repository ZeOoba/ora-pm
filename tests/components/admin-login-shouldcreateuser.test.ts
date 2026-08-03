import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-036: admin accounts must be pre-created in Supabase (via the dashboard) rather
// than self-provisioning on first OTP login. No React-rendering test harness exists
// in this repo — no jsdom environment and no @testing-library/react dependency (see
// vitest.config.ts's `environment: 'node'` and package.json) — so, matching the
// established pattern in this directory (see portal-paynow-client-request-id.test.ts,
// portal-charge-field-drift.test.ts), this reads the component source directly
// rather than mounting it.
describe('AdminLogin — shouldCreateUser: false (OI-036)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/pages/auth/AdminLogin.tsx'),
    'utf-8'
  )

  it('calls signInWithOtp with shouldCreateUser: false, so unregistered emails cannot self-provision an admin account', () => {
    expect(source).toMatch(
      /signInWithOtp\(\{[\s\S]*?options:\s*\{[\s\S]*?shouldCreateUser:\s*false[\s\S]*?\}[\s\S]*?\}\)/
    )
  })
})
