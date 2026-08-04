// tests/routes/expenses-error-hygiene.test.ts
//
// OI-063 (OI-042's self-flagged 5-file gap): expenses.ts returned raw
// Postgres/PostgREST error.message to the client on 2 sites. Fixed via the
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

const RAW_MESSAGE = 'column "expenses.internal_gl_code" does not exist in table "expenses_ledger_shadow"'

describe('GET /api/expenses error hygiene', () => {
  it('returns a generic 500 message, never the raw Postgres error, on list failure', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          range: vi.fn().mockResolvedValue({ data: null, error: { message: RAW_MESSAGE, code: '42703' } }),
        }),
      }),
    })
    const res = await app.request('/api/expenses', {}, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/internal_gl_code|expenses_ledger_shadow/)
    expect(json.error).toBe('Failed to load expenses')
  })
})

describe('DELETE /api/expenses/:id error hygiene', () => {
  it('returns a generic 500 message, never the raw Postgres error, on delete failure', async () => {
    mockFrom.mockReturnValue({
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: { message: RAW_MESSAGE, code: '23503' } }),
      }),
    })
    const res = await app.request('/api/expenses/exp_1', { method: 'DELETE' }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/internal_gl_code|expenses_ledger_shadow/)
  })
})
