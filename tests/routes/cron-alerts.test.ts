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
}
const app = createApp()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})

describe('POST /api/cron/critical-dates-alerts', () => {
  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/critical-dates-alerts', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('queries critical_dates and returns email: null when no alerts due', async () => {
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
    const body = await res.json() as { new_alerts: number; email: unknown }
    expect(body.new_alerts).toBe(0)
    expect(body.email).toBeNull()
  })

  it('records new alerts and returns a populated email digest, not a Resend call', async () => {
    let insertedBefore: unknown = null
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return {
        select: vi.fn().mockReturnValue({
          lte: vi.fn().mockResolvedValue({
            data: [
              { date_type: 'lease_expiration', reference_id: 'lease_1', tenant_name: 'Acme', property_name: '9050 Red Branch', suite: '101', critical_date: '2026-07-01', days_until: 26, urgency: 'urgent' },
            ],
            error: null,
          }),
        }),
      }
      if (table === 'sent_notifications') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert: vi.fn().mockImplementation((rows: unknown[]) => {
          insertedBefore = rows
          return Promise.resolve({ error: null })
        }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/critical-dates-alerts', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { new_alerts: number; skipped: number; email: { subject: string; body: string } | null }
    expect(body.new_alerts).toBe(1)
    expect(body.skipped).toBe(0)
    // Proves the handler called insert with the right dedup rows before
    // returning this response — it does NOT by itself prove the insert
    // resolved before the digest was built (that ordering is proven by the
    // separate "never returns email content when the dedup write fails"
    // test below, which shows no digest is returned when the insert fails).
    expect(insertedBefore).toEqual([
      { notification_type: 'critical_date_alert', reference_id: 'lease_1', recipient: 'ggoldberg@oxfordra.net' },
    ])
    expect(body.email).not.toBeNull()
    expect(body.email!.subject).toContain('1 Critical Date')
    expect(body.email!.body).toContain('Acme')
    expect(body.email!.body).toContain('9050 Red Branch')
    // Resend is gone — no fetch of any kind from this handler anymore.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips alerts already sent to the (single) recipient', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return {
        select: vi.fn().mockReturnValue({
          lte: vi.fn().mockResolvedValue({
            data: [
              { date_type: 'lease_expiration', reference_id: 'lease_1', tenant_name: 'Acme', property_name: '9050 Red Branch', suite: '101', critical_date: '2026-07-01', days_until: 26, urgency: 'urgent' },
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
    const body = await res.json() as { new_alerts: number; skipped: number; email: unknown }
    expect(body.new_alerts).toBe(0)
    expect(body.skipped).toBe(1)
    expect(body.email).toBeNull()
  })

  it('never returns email content when the dedup write fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return {
        select: vi.fn().mockReturnValue({
          lte: vi.fn().mockResolvedValue({
            data: [
              { date_type: 'lease_expiration', reference_id: 'lease_1', tenant_name: 'Acme', property_name: '9050 Red Branch', suite: '101', critical_date: '2026-07-01', days_until: 26, urgency: 'urgent' },
            ],
            error: null,
          }),
        }),
      }
      if (table === 'sent_notifications') return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert: vi.fn().mockResolvedValue({ error: { message: 'boom' } }),
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/critical-dates-alerts', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string; email?: unknown }
    expect(body.error).toContain('boom')
    expect(body.email).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('POST /api/cron/delinquency-check', () => {
  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/delinquency-check', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('returns email: null when no delinquent leases', async () => {
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
    const body = await res.json() as { late_fees_posted: number; email: unknown }
    expect(body.late_fees_posted).toBe(0)
    expect(body.email).toBeNull()
  })

  it('posts a late fee and returns a populated email digest, not a Resend call', async () => {
    let chargesCall = 0
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ar_ledger') return {
        select: vi.fn().mockReturnValue({
          gt: vi.fn().mockResolvedValue({
            data: [{ lease_id: 'lease_1', tenant_id: 't1', tenant_name: 'Acme', property_name: null, suite: '101', balance: 1200 }],
            error: null,
          }),
        }),
      }
      if (table === 'charges') {
        chargesCall++
        if (chargesCall === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                lte: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: [{ id: 'ch1', due_date: '2026-04-01', amount: 1200 }], error: null }),
                  }),
                }),
              }),
            }),
          }
        }
        if (chargesCall === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  gte: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          }
        }
        return { insert: vi.fn().mockResolvedValue({ error: null }) }
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/delinquency-check', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { late_fees_posted: number; delinquent_count: number; email: { subject: string; body: string } | null }
    expect(body.late_fees_posted).toBe(1)
    expect(body.delinquent_count).toBe(1)
    expect(body.email).not.toBeNull()
    expect(body.email!.subject).toContain('1 Delinquent Tenant')
    expect(body.email!.body).toContain('Acme')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not double-post when a late fee already exists this period', async () => {
    let chargesCall = 0
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ar_ledger') return {
        select: vi.fn().mockReturnValue({
          gt: vi.fn().mockResolvedValue({
            data: [{ lease_id: 'lease_1', tenant_id: 't1', tenant_name: 'Acme', property_name: null, suite: '101', balance: 1200 }],
            error: null,
          }),
        }),
      }
      if (table === 'charges') {
        chargesCall++
        if (chargesCall === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                lte: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: [{ id: 'ch1', due_date: '2026-04-01', amount: 1200 }], error: null }),
                  }),
                }),
              }),
            }),
          }
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                gte: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [{ id: 'fee1' }], error: null }),
                }),
              }),
            }),
          }),
        }
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/delinquency-check', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { late_fees_posted: number; delinquent_count: number; email: { subject: string; body: string } | null }
    expect(body.late_fees_posted).toBe(0)
    expect(body.delinquent_count).toBe(1)
    // Still delinquent (even without a fresh fee this period) — the digest
    // must still report it, matching the current bodyText behavior.
    expect(body.email).not.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
