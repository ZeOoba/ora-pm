// PR #42 refute (Important 1, sweep): DELETE /api/charges/:id pre-reads the charge's `source` and
// discarded that read's `error` — a failed query fell through `!charge` and answered 404 ("Charge
// not found") for what was really a DB failure, and never surfaced it. Fail closed via dbError
// (500, generic text); a genuine no-row result (PGRST116) is still 404.
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
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const RAW_MESSAGE = 'column "charges.voided_at" does not exist in table "charges_shadow"'

function chargesTable(single: { data: unknown; error: unknown }, deleteSpy = vi.fn()) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue(single) }),
    }),
    delete: deleteSpy.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
  }
}

describe('DELETE /api/charges/:id — pre-read error hygiene', () => {
  it('returns a generic 500 (not 404, not the raw Postgres text) and never deletes when the source pre-read fails', async () => {
    const deleteSpy = vi.fn()
    mockFrom.mockReturnValue(chargesTable({ data: null, error: { message: RAW_MESSAGE, code: '42703' } }, deleteSpy))

    const res = await app.request('/api/charges/charge_1', { method: 'DELETE' }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/voided_at|charges_shadow|42703/)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('still answers 404 for a genuinely missing charge (PGRST116 is "no row", not a failure)', async () => {
    const deleteSpy = vi.fn()
    mockFrom.mockReturnValue(chargesTable(
      { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
      deleteSpy,
    ))

    const res = await app.request('/api/charges/charge_missing', { method: 'DELETE' }, env)
    expect(res.status).toBe(404)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('still refuses to delete an auto charge (400) — unchanged', async () => {
    const deleteSpy = vi.fn()
    mockFrom.mockReturnValue(chargesTable({ data: { source: 'auto' }, error: null }, deleteSpy))

    const res = await app.request('/api/charges/charge_auto', { method: 'DELETE' }, env)
    expect(res.status).toBe(400)
    expect(deleteSpy).not.toHaveBeenCalled()
  })
})
