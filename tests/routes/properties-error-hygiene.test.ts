// tests/routes/properties-error-hygiene.test.ts
//
// OI-063 (OI-042's self-flagged 5-file gap): properties.ts returned raw
// Postgres/PostgREST error.message to the client on 3 sites. Fixed via the
// dbError() helper (same pattern as tests/routes/webhook.test.ts).

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

const RAW_MESSAGE = 'relation "properties_secret_column" violates constraint "fk_owner_llc_registry"'

describe('GET /api/properties error hygiene', () => {
  it('returns a generic 500 message, never the raw Postgres error, on list failure', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        // list queries now order by the requested column then by id (stable paging)
        order: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            range: vi.fn().mockResolvedValue({ data: null, error: { message: RAW_MESSAGE, code: '42P01' } }),
          }),
        }),
      }),
    })
    const res = await app.request('/api/properties', {}, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/properties_secret_column|fk_owner_llc_registry/)
    expect(json.error).toBe('Failed to load properties')
  })
})

describe('GET /api/properties/:id error hygiene', () => {
  it('returns a generic 404 message, never the raw Postgres error, on lookup failure', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: RAW_MESSAGE, code: 'PGRST116' } }),
        }),
      }),
    })
    const res = await app.request('/api/properties/prop_1', {}, env)
    expect(res.status).toBe(404)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/properties_secret_column|fk_owner_llc_registry/)
  })
})

describe('DELETE /api/properties/:id error hygiene', () => {
  it('returns a generic 500 message, never the raw Postgres error, on delete failure', async () => {
    mockFrom.mockReturnValue({
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: { message: RAW_MESSAGE, code: '23503' } }),
      }),
    })
    const res = await app.request('/api/properties/prop_1', { method: 'DELETE' }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/properties_secret_column|fk_owner_llc_registry/)
  })
})
