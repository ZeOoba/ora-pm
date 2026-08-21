// tests/routes/portal-autopay-aal-integration.test.ts
//
// OI-045 — end-to-end proof that the REAL requireAal2 middleware is really
// wired onto the REAL PATCH /api/portal/autopay route in the REAL app,
// closing the exact bypass the REFUTE finding demonstrated: a tenant with a
// valid bearer JWT and a verified TOTP factor, but whose current session
// hasn't completed the AAL2 challenge, could call the endpoint directly
// (curl/fetch — no browser, no SPA gate involved) and enable ACH autopay.
//
// Deliberately does NOT mock tenant-auth or aal-guard themselves (unlike
// tests/routes/portal.test.ts, which auto-passes both to test /autopay's
// OWN logic in isolation) — only the lowest-level @supabase/supabase-js
// client is mocked, so both real middlewares run for real against it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockGetUser = vi.hoisted(() => vi.fn())
const mockGetAal = vi.hoisted(() => vi.fn())
const mockFrom = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser, mfa: { getAuthenticatorAssuranceLevel: mockGetAal } },
    from: mockFrom,
  }),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()

function patchAutopay(jwt: string, body: unknown) {
  return app.request('/api/portal/autopay', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

// Happy-path DB mock — armed so that if the AAL gate were NOT actually
// enforced, this request would sail through to a 200. Its presence is what
// makes the 403 assertions below mean something: the request is blocked
// DESPITE everything downstream being ready to succeed.
function armDbHappyPath() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'tenants') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1', stripe_customer_id: 'cus_1' }, error: null }),
          }),
        }),
      }
    }
    if (table === 'leases') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'lease_1', tenant_id: 'tenant_1' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      }
    }
    return { select: vi.fn() }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user_test' } }, error: null })
  armDbHappyPath()
})

describe('PATCH /api/portal/autopay — real requireAal2 wired onto the real route', () => {
  it('THE EXACT PoC FROM THE REFUTE FINDING: a direct API call with a valid JWT but no AAL2 step-up is blocked — no browser, no SPA involved', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    })

    const res = await patchAutopay('valid_but_aal1_jwt', {
      lease_id: 'lease_1',
      enabled: true,
      payment_method_id: 'pm_attacker_controlled',
    })

    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/multi-factor|mfa|aal2/i)
  })

  it('a genuine aal2 session (real MFA step-up completed) still succeeds end-to-end', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    })

    // enabled:false takes the disable branch, which never calls Stripe —
    // keeps this integration test focused on the AAL gate, not autopay's
    // own PM-ownership logic (already covered by tests/routes/portal.test.ts).
    const res = await patchAutopay('valid_aal2_jwt', { lease_id: 'lease_1', enabled: false })
    expect(res.status).toBe(200)
  })

  it('OI-081: a tenant with no verified MFA factor at all (nextLevel never rises to aal2) is now BLOCKED, not waved through', async () => {
    mockGetAal.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
      error: null,
    })

    const res = await patchAutopay('valid_no_mfa_jwt', { lease_id: 'lease_1', enabled: false })
    expect(res.status).toBe(403)
  })

  it('rejects with 401 before ever reaching the AAL check when the JWT itself is invalid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid JWT' } })

    const res = await patchAutopay('garbage', { lease_id: 'lease_1', enabled: true })
    expect(res.status).toBe(401)
    expect(mockGetAal).not.toHaveBeenCalled()
  })
})
