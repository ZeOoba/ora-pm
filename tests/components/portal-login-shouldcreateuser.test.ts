import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-080: tenant accounts must be provisioned exclusively via portal-auth.ts's
// inviteUserByEmail, never self-provisioned on first OTP login. AdminLogin.tsx's
// OI-036 fix covered the admin login page only — this is the tenant-portal twin,
// same source-read pattern as admin-login-shouldcreateuser.test.ts (see that file
// for why: no jsdom/React-rendering harness in this repo).
describe('PortalLogin — shouldCreateUser: false (OI-080)', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalLogin.tsx'),
    'utf-8'
  )

  it('calls signInWithOtp with shouldCreateUser: false, so unregistered emails cannot self-provision a tenant account', () => {
    expect(source).toMatch(
      /signInWithOtp\(\{[\s\S]*?options:\s*\{[\s\S]*?shouldCreateUser:\s*false[\s\S]*?\}[\s\S]*?\}\)/
    )
  })
})
