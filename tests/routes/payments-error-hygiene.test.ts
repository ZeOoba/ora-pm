// tests/routes/payments-error-hygiene.test.ts
//
// OI-063 (OI-042's self-flagged 5-file gap): payments.ts returned raw
// Postgres/PostgREST error.message to the client on 1 site. Fixed via the
// dbError() helper.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()
beforeEach(() => vi.clearAllMocks())

const RAW_MESSAGE = 'duplicate key value violates unique constraint "payments_stripe_pi_uniq"'

describe('GET /api/payments error hygiene', () => {
  it('returns a generic 500 message, never the raw Postgres error, on list failure', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          range: vi.fn().mockResolvedValue({ data: null, error: { message: RAW_MESSAGE, code: '23505' } }),
        }),
      }),
    })
    const res = await app.request('/api/payments', {}, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/payments_stripe_pi_uniq/)
    expect(json.error).toBe('Failed to load payments')
  })
})
