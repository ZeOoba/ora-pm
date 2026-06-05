import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  RESEND_API_KEY: undefined,
}
const app = createApp()
beforeEach(() => vi.clearAllMocks())

describe('POST /api/cron/critical-dates-alerts', () => {
  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/critical-dates-alerts', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('queries critical_dates and returns summary when no alerts due', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return {
        select: vi.fn().mockReturnValue({
          lte: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }
      if (table === 'sent_notifications') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/critical-dates-alerts', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { new_alerts: number }
    expect(body.new_alerts).toBe(0)
  })

  it('records new alerts and returns count', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return {
        select: vi.fn().mockReturnValue({
          lte: vi.fn().mockResolvedValue({
            data: [
              { date_type: 'lease_expiration', reference_id: 'lease_1', tenant_name: 'Acme', property_name: 'REDACTED-020', suite: '101', critical_date: '2026-07-01', days_until: 26, urgency: 'urgent' },
            ],
            error: null,
          }),
        }),
      }
      if (table === 'sent_notifications') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert: vi.fn().mockReturnValue({ error: null }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/critical-dates-alerts', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { new_alerts: number; skipped: number }
    expect(body.new_alerts).toBe(1)
    expect(body.skipped).toBe(0)
  })

  it('skips alerts already sent to all recipients', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return {
        select: vi.fn().mockReturnValue({
          lte: vi.fn().mockResolvedValue({
            data: [
              { date_type: 'lease_expiration', reference_id: 'lease_1', tenant_name: 'Acme', property_name: 'REDACTED-020', suite: '101', critical_date: '2026-07-01', days_until: 26, urgency: 'urgent' },
            ],
            error: null,
          }),
        }),
      }
      if (table === 'sent_notifications') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({
            data: [
              { reference_id: 'lease_1', recipient: 'ggoldberg@oxfordra.net' },
              { reference_id: 'lease_1', recipient: 'egoldberg@oxfordra.net' },
            ],
            error: null,
          }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/critical-dates-alerts', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { new_alerts: number; skipped: number }
    expect(body.new_alerts).toBe(0)
    expect(body.skipped).toBe(1)
  })
})

describe('POST /api/cron/delinquency-check', () => {
  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/delinquency-check', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('returns 0 late fees when no delinquent leases', async () => {
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        gt: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    }))

    const res = await app.request('/api/cron/delinquency-check', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { late_fees_posted: number }
    expect(body.late_fees_posted).toBe(0)
  })
})
