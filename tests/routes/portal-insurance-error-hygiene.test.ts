// tests/routes/portal-insurance-error-hygiene.test.ts
//
// OI-063 (OI-042's self-flagged 5-file gap): portal-insurance.ts returned raw
// Postgres/PostgREST error.message to the client on 1 site — the most
// sensitive of the 5 gap files, since this route is directly tenant-portal
// reachable (any authenticated tenant), not admin-only. Fixed via the
// dbError() helper.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

vi.mock('../../server/middleware/tenant-auth', () => ({
  tenantAuthMiddleware: vi.fn(async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('tenantUserId', 'user_test')
    await next()
  }),
}))

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()
beforeEach(() => vi.clearAllMocks())

const RAW_MESSAGE = 'new row violates row-level security policy for table "insurance_certificates"'
const VALID_BODY = {
  policy_type: 'general_liability',
  effective_date: '2026-01-01',
  expiration_date: '2027-01-01',
}

describe('POST /api/portal/insurance error hygiene', () => {
  it('returns a generic 500 message, never the raw Postgres/RLS error, on insert failure', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
            }),
          }),
        }
      }
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: RAW_MESSAGE, code: '42501' } }),
          }),
        }),
      }
    })

    const res = await app.request('/api/portal/insurance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/row-level security policy|insurance_certificates/)
    expect(json.error).toBe('Failed to save insurance certificate')
  })
})
