// OI-310: DELETE /api/charges/:id refused `source='auto'` charges but never looked at `voided_at`,
// even though migration 0016's whole premise is "void, never delete" for an audit trail. The two
// conditions do not overlap today (0017 only voids auto rows, which the source check already
// refuses), so this is a latent gap, not a live bug — these tests exist to pin the guard down
// BEFORE a manual-void action makes it reachable, and to fail loudly if someone later prunes it as
// unreachable code.
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

function chargesTable(row: unknown, deleteSpy = vi.fn()) {
  const selectSpy = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: row, error: null }) }),
  })
  return {
    select: selectSpy,
    delete: deleteSpy.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    __selectSpy: selectSpy,
  }
}

describe('DELETE /api/charges/:id — voided-charge guard (OI-310)', () => {
  it('refuses to delete a manual charge that has been voided, and never issues the delete', async () => {
    const deleteSpy = vi.fn()
    mockFrom.mockReturnValue(chargesTable({ source: 'manual', voided_at: '2026-09-17T00:00:00Z' }, deleteSpy))

    const res = await app.request('/api/charges/charge_voided', { method: 'DELETE' }, env)

    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/voided/i)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('still deletes an ordinary un-voided manual charge', async () => {
    const deleteSpy = vi.fn()
    mockFrom.mockReturnValue(chargesTable({ source: 'manual', voided_at: null }, deleteSpy))

    const res = await app.request('/api/charges/charge_live', { method: 'DELETE' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(deleteSpy).toHaveBeenCalled()
  })

  it('keeps refusing auto charges regardless of void state (the pre-existing guard is untouched)', async () => {
    const deleteSpy = vi.fn()
    mockFrom.mockReturnValue(chargesTable({ source: 'auto', voided_at: null }, deleteSpy))

    const res = await app.request('/api/charges/charge_auto', { method: 'DELETE' }, env)

    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/auto/i)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  // REFUTE pass (Fable, 2026-09-18) finding 4: the commit message calls the `!== null` fail-closed
  // property deliberate, but nothing exercised it. `getDb` returns an untyped client, so the
  // `as { voided_at: string | null }` cast is a no-op and TypeScript offers zero protection here --
  // this test is the only thing that holds the property.
  it('fails CLOSED when voided_at is absent from the row entirely (a dropped select must not silently disable the guard)', async () => {
    const deleteSpy = vi.fn()
    mockFrom.mockReturnValue(chargesTable({ source: 'manual' }, deleteSpy))

    const res = await app.request('/api/charges/charge_no_field', { method: 'DELETE' }, env)

    expect(res.status).toBe(400)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('actually asks the database for voided_at — a guard reading a column it never selected is a guard that never fires', async () => {
    const table = chargesTable({ source: 'manual', voided_at: null })
    mockFrom.mockReturnValue(table)

    await app.request('/api/charges/charge_live', { method: 'DELETE' }, env)

    expect(table.__selectSpy).toHaveBeenCalledWith(expect.stringContaining('voided_at'))
  })
})
