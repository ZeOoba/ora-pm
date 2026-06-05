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

describe('GET /api/leases/:id/notices', () => {
  it('returns notices for a lease', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenant_notices') return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [{ id: 'n1', lease_id: 'lease_1', notice_type: 'late_payment', sent_date: '2026-06-01', method: 'email', notes: null }],
              error: null,
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/leases/lease_1/notices', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string }[] }
    expect(body.data).toHaveLength(1)
  })
})

describe('POST /api/leases/:id/notices', () => {
  it('creates a notice and returns 201', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenant_notices') return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'n2', lease_id: 'lease_1', notice_type: 'late_payment', sent_date: '2026-06-05', method: 'email', notes: null },
              error: null,
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/leases/lease_1/notices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notice_type: 'late_payment', sent_date: '2026-06-05', method: 'email' }),
    }, env)
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    expect(body.data.id).toBe('n2')
  })

  it('returns 400 when notice_type is missing', async () => {
    const res = await app.request('/api/leases/lease_1/notices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent_date: '2026-06-05' }),
    }, env)
    expect(res.status).toBe(400)
  })
})
