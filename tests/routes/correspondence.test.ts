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

describe('POST /api/tenants/:id/correspondence', () => {
  it('creates a correspondence entry and returns 201', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'correspondence_log') return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'c1', tenant_id: 'tenant_1', direction: 'outbound', contact_date: '2026-06-05', subject: 'Rent due', summary: 'Called about June rent', method: 'phone' },
              error: null,
            }),
          }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/tenants/tenant_1/correspondence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction: 'outbound', contact_date: '2026-06-05', subject: 'Rent due', summary: 'Called about June rent', method: 'phone' }),
    }, env)
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    expect(body.data.id).toBe('c1')
  })

  it('returns 422 when required fields are missing', async () => {
    const res = await app.request('/api/tenants/tenant_1/correspondence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction: 'outbound' }),
    }, env)
    expect(res.status).toBe(422)
    const body = await res.json() as { error: Record<string, string[]> }
    expect(body.error.contact_date).toBeDefined()
    expect(body.error.subject).toBeDefined()
  })

  // RED (OI-041 remainder): this route used to destructure explicit fields
  // by hand with no Zod validation. Now enforced by
  // TenantCorrespondenceInsertSchema.strict().
  it('rejects an unexpected field (id) with 422 and never calls insert', async () => {
    const insertSpy = vi.fn()
    mockFrom.mockImplementation((table: string) => {
      if (table === 'correspondence_log') return {
        insert: insertSpy.mockReturnValue({
          select: vi.fn().mockReturnValue({ single: vi.fn() }),
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/tenants/tenant_1/correspondence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: 'outbound', contact_date: '2026-06-05', subject: 'Rent due',
        summary: 'Called about June rent', method: 'phone',
        id: 'attacker-uuid', created_at: '1999-01-01',
      }),
    }, env)
    expect(res.status).toBe(422)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
