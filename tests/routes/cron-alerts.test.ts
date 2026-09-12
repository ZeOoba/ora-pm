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
        // Call 1: bulk recent-charges sum (OI-234) -> no charges newer than the grace cutoff, so
        // the whole 1200 balance is overdue. Call 2: bulk existing-fee check -> no fee posted yet
        // this period. Call 3: the insert itself.
        if (chargesCall === 1) return chainable([])
        if (chargesCall === 2) return chainable([])
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
      // Call 1 (OI-234 recent-charges sum): only this month's $50 fee is newer than the cutoff, so
      // 1150 of the 1200 balance is overdue. Call 2 (existing-fee check): lease_1 already fee'd
      // this period — so the insert branch (a 3rd `.from('charges')` call) should never fire.
      if (table === 'charges') {
        chargesCall++
        if (chargesCall === 1) return chainable([{ lease_id: 'lease_1', amount: 50 }])
        return chainable([{ lease_id: 'lease_1' }])
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

  // Generic auto-chaining/auto-resolving stub: any method call returns the same proxy (so it
  // tolerates either the old per-lease .eq(...) chain shape or the new bulk .in(...) shape without
  // the test needing to know which), and `await`-ing it at any point resolves to {data, error} via
  // the 'then' trap. Isolates this regression test from the exact query-builder shape so it fails
  // on CALL COUNT (the actual bug) rather than on a shape mismatch.
  function chainable(data: unknown, error: unknown = null): unknown {
    return new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data, error })
        return () => chainable(data, error)
      },
    })
  }

  it('does O(1) bulk delinquency-lookup queries, not one-per-lease (N+1 regression, 2026-08-17)', async () => {
    const N = 5
    const arRows = Array.from({ length: N }, (_, i) => ({
      lease_id: `lease_${i}`, tenant_id: `t${i}`, tenant_name: `Tenant ${i}`, property_name: 'Prop', suite: `${i}`, balance: 1000,
    }))

    let chargesFromCalls = 0
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ar_ledger') return {
        select: vi.fn().mockReturnValue({
          gt: vi.fn().mockResolvedValue({ data: arRows, error: null }),
        }),
      }
      if (table === 'charges') {
        chargesFromCalls++
        // Every bulk lookup reports every lease as overdue (a $0 recent charge leaves the full
        // 1000 balance overdue under OI-234's recent-sum) AND already fee'd this period, so the
        // insert branch is never reached — isolates the SELECT-side N+1 fix from insert-call count.
        return chainable(arRows.map((r) => ({ lease_id: r.lease_id, amount: 0 })))
      }
      return { select: vi.fn() }
    })

    const res = await app.request('/api/cron/delinquency-check', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { delinquent_count: number }
    expect(body.delinquent_count).toBe(N)

    // Pre-fix: 2 selects PER lease (overdue-check + existing-fee-check) -> scales with N (10 for
    // N=5). Post-fix: exactly 2 bulk `.in()` calls total, independent of N.
    expect(chargesFromCalls).toBeLessThanOrEqual(2)
  })
})
