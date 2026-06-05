import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

// Auto-pass tenant auth middleware in tests
vi.mock('../../server/middleware/tenant-auth', () => ({
  tenantAuthMiddleware: vi.fn(async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('tenantUserId', 'user_test')
    await next()
  }),
}))

const mockFrom = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mockFrom }),
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

describe('GET /api/portal/me', () => {
  it('returns tenant profile and total balance', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'tenant_1', name: 'Test Co', contact_email: 'x@y.com', stripe_customer_id: 'cus_1', auth_user_id: 'user_test' },
              error: null,
            }),
          }),
        }),
      }
      if (table === 'ar_ledger') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [{ balance: 500 }, { balance: 250 }], error: null }),
        }),
      }
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) }
    })

    const res = await app.request('/api/portal/me', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { tenant: { id: string }; total_balance: number }
    expect(body.tenant.id).toBe('tenant_1')
    expect(body.total_balance).toBe(750)
  })
})

describe('GET /api/portal/charges', () => {
  it('returns charges for active leases', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [{ id: 'lease_1' }], error: null }),
          }),
        }),
      }
      if (table === 'charges') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [{ id: 'charge_1', amount: 1200 }], error: null }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/charges', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string }[] }
    expect(body.data).toHaveLength(1)
  })

  it('returns empty array when tenant has no active leases', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/charges', {
      headers: { Authorization: 'Bearer valid' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data).toHaveLength(0)
  })
})

describe('PATCH /api/portal/autopay', () => {
  it('enables autopay with payment method', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'lease_1', tenant_id: 'tenant_1' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_1', enabled: true, payment_method_id: 'pm_bank' }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { autopay_enabled: boolean }
    expect(body.autopay_enabled).toBe(true)
  })

  it('returns 404 when lease belongs to a different tenant (IDOR guard)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'tenant_1' }, error: null }),
          }),
        }),
      }
      if (table === 'leases') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              // lease belongs to a DIFFERENT tenant
              data: { id: 'lease_other', tenant_id: 'tenant_other' },
              error: null,
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/portal/autopay', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: 'lease_other', enabled: true }),
    }, env)
    expect(res.status).toBe(404)
  })
})
