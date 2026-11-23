// PUT /api/leases/:id on a lease billed from its schedule (lease abstraction plan §5a item 2).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test', CRON_SECRET: 'test', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh' }
const app = createApp()
const ID = '11111111-1111-1111-1111-111111111111'

const state = {
  lease: { base_rent_monthly: 5000, cam_estimate_monthly: 300, start_date: '2026-01-01', end_date: '2028-12-31' },
  rent: [] as { effective_start: string; effective_end: string; superseded_at: string | null }[],
  cam: [] as { id: string }[],
  readError: null as { message: string } | null,
}
const updateSpy = vi.fn()

// A thenable chain that ignores filters and resolves to `result`.
function chain(result: () => unknown) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit']) b[m] = () => b
  b.maybeSingle = async () => result()
  b.then = (resolve: (v: unknown) => void) => resolve(result())
  return b
}

beforeEach(() => {
  vi.clearAllMocks()
  state.rent = []
  state.cam = []
  state.readError = null
  mockFrom.mockImplementation((table: string) => {
    if (table === 'lease_rent_schedule') return chain(() => ({ data: state.rent, error: state.readError }))
    if (table === 'lease_recurring_charges') return chain(() => ({ data: state.cam, error: null }))
    if (table === 'leases') {
      return {
        ...chain(() => ({ data: state.lease, error: null })),
        update: (row: unknown) => {
          updateSpy(row)
          return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: ID, ...(row as object) }, error: null }) }) }) }
        },
      }
    }
    throw new Error(`unexpected table ${table}`)
  })
})

const put = (body: object) => app.request(`/api/leases/${ID}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)

describe('PUT /api/leases/:id — scheduled lease guard', () => {
  it('refuses a base-rent edit on a scheduled lease (409) and writes nothing', async () => {
    state.rent = [{ effective_start: '2026-01-01', effective_end: '2028-12-31', superseded_at: null }]
    const res = await put({ base_rent_monthly: 5200 })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/rent schedule/)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('allows the same edit on a lease with no schedule', async () => {
    const res = await put({ base_rent_monthly: 5200 })
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ base_rent_monthly: 5200 })
  })

  it('refuses extending the term past the schedule', async () => {
    state.rent = [{ effective_start: '2026-01-01', effective_end: '2028-12-31', superseded_at: null }]
    expect((await put({ end_date: '2030-12-31' })).status).toBe(409)
  })

  it('a failed schedule read refuses the edit (never writes blind)', async () => {
    state.readError = { message: 'down' }
    const res = await put({ base_rent_monthly: 5200 })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
