import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable, type Row } from '../fixtures/pg-table'

// B13: GET /api/portal/aging (tenant), GET /api/portal/me fail-closed balance, and the admin-only
// GET /api/tenants/:id/portal-preview, which must return exactly what the portal returns.
vi.mock('../../server/middleware/tenant-auth', () => ({
  tenantAuthMiddleware: vi.fn(async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('tenantUserId', 'user_a'); return next() }),
}))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))
const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test', CRON_SECRET: 'x', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }
const app = createApp()

const TA = '11111111-1111-4111-8111-111111111111'
const TB = '22222222-2222-4222-8222-222222222222'
const L1 = 'lease_a1'
const L2 = 'lease_a2'
const LB = 'lease_b1'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 10, 10, 12))
})
afterEach(() => { vi.useRealTimers() })

function world(opts: { ledgerError?: boolean } = {}) {
  const tenants: Row[] = [
    { id: TA, name: 'KC Brewing Supply', contact_email: 'ap@kc.test', stripe_customer_id: null, auth_user_id: 'user_a' },
    { id: TB, name: 'Other Tenant', contact_email: 'x@b.test', stripe_customer_id: null, auth_user_id: 'user_b' },
  ]
  const leases: Row[] = [
    { id: L1, tenant_id: TA, status: 'active' },
    { id: L2, tenant_id: TA, status: 'active' },
    { id: LB, tenant_id: TB, status: 'active' },
  ]
  // L1 owes 6,340.18 (two CAM charges 70 and 40 days old); L2 holds a 250.00 credit (string NUMERIC).
  const ledger: Row[] = [
    { lease_id: L1, tenant_id: TA, unit_id: 'u1', tenant_name: 'KC Brewing Supply', property_id: 'p', property_name: 'Raytown Flex', suite: '3', total_charged: 6340.18, total_paid: 0, balance: 6340.18 },
    { lease_id: L2, tenant_id: TA, unit_id: 'u2', tenant_name: 'KC Brewing Supply', property_id: 'p', property_name: 'Raytown Flex', suite: '4', total_charged: 0, total_paid: 250, balance: '-250.00' },
    { lease_id: LB, tenant_id: TB, unit_id: 'u9', tenant_name: 'Other Tenant', property_id: 'p', property_name: 'Raytown Flex', suite: '9', total_charged: 999, total_paid: 0, balance: 999 },
  ]
  const charges: Row[] = [
    { id: 'c1', lease_id: L1, amount: 3170.09, due_date: '2026-09-01', voided_at: null, type: 'cam_estimate' },
    { id: 'c2', lease_id: L1, amount: 3170.09, due_date: '2026-10-01', voided_at: null, type: 'cam_estimate' },
    { id: 'c9', lease_id: LB, amount: 999, due_date: '2026-10-01', voided_at: null, type: 'rent' },
  ]
  const tables: Record<string, ReturnType<typeof pgTable>> = {
    tenants: pgTable(tenants),
    leases: pgTable(leases),
    ar_ledger: pgTable(ledger, opts.ledgerError ? { error: { message: 'relation ar_ledger is broken' } } : {}),
    charges: pgTable(charges),
    payments: pgTable([{ id: 'pay1', lease_id: L1, amount: 100, payment_date: '2026-10-28', stripe_status: 'succeeded' }]),
  }
  mockFrom.mockImplementation((t: string) => {
    if (!tables[t]) throw new Error(`unexpected table ${t}`)
    return tables[t]
  })
  return tables
}

const json = async (path: string) => {
  const res = await app.request(path, { headers: { Authorization: 'Bearer x' } }, env)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('GET /api/portal/aging', () => {
  it("returns only the caller's own positive-balance leases, aged by the shared allocator, tenant-safe fields only", async () => {
    world()
    const { status, body } = await json('/api/portal/aging')
    expect(status).toBe(200)
    const rows = body.data as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      lease_id: L1, property_name: 'Raytown Flex', suite: '3', balance: 6340.18,
      buckets: { current: 0, d1_30: 0, d31_60: 3170.09, d61_90: 3170.09, d90_plus: 0, unallocated: 0 },
    })
    expect(Object.keys(rows[0])).not.toContain('tenant_name')
    expect(body.totals).toMatchObject({ balance: 6340.18 })
  })
})

describe('GET /api/portal/me', () => {
  it('sums every ar_ledger row in cents, credits included, even when NUMERIC arrives as a string', async () => {
    world()
    const { status, body } = await json('/api/portal/me')
    expect(status).toBe(200)
    expect(body.total_balance).toBe(6090.18)
  })

  it('fails closed (no $0 balance) when the ar_ledger read fails', async () => {
    world({ ledgerError: true })
    const { status, body } = await json('/api/portal/me')
    expect(status).toBe(500)
    expect(body).not.toHaveProperty('total_balance')
    expect(JSON.stringify(body)).not.toContain('relation ar_ledger is broken')
  })
})

describe('GET /api/tenants/:id/portal-preview (admin)', () => {
  it('returns exactly the payloads the tenant would get from their own portal endpoints', async () => {
    world()
    const preview = (await json(`/api/tenants/${TA}/portal-preview`)).body
    world()
    const me = (await json('/api/portal/me')).body
    world()
    const charges = (await json('/api/portal/charges')).body
    world()
    const payments = (await json('/api/portal/payments')).body
    world()
    const aging = (await json('/api/portal/aging')).body
    expect(preview.me).toEqual(me)
    expect(preview.charges).toEqual(charges)
    expect(preview.payments).toEqual(payments)
    expect(preview.aging).toEqual(aging)
  })

  it('uses the tenant-safe lease projection, never leases.*', async () => {
    const t = world()
    await json(`/api/tenants/${TA}/portal-preview`)
    const selects = (t.leases as unknown as { pages: { method: string; args: unknown[] }[][] }).pages
    expect(selects.length).toBeGreaterThan(0)
    const src = await import('../../server/lib/portal-data')
    expect(src.PORTAL_LEASE_SELECT).not.toContain('*')
    expect(src.PORTAL_LEASE_SELECT).not.toMatch(/\bnotes\b|\boptions\b|ti_allowance|expense_stop/)
  })

  it('422 for a non-uuid id, 404 for an unknown tenant', async () => {
    world()
    expect((await json('/api/tenants/not-a-uuid/portal-preview')).status).toBe(422)
    expect((await json('/api/tenants/33333333-3333-4333-8333-333333333333/portal-preview')).status).toBe(404)
  })

  it('fails as a whole (no partial preview) when any read fails', async () => {
    world({ ledgerError: true })
    const { status, body } = await json(`/api/tenants/${TA}/portal-preview`)
    expect(status).toBe(500)
    expect(body).not.toHaveProperty('me')
  })
})
