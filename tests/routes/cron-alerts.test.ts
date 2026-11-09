import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable, PG_MAX_ROWS, type Row, type Call } from '../fixtures/pg-table'

const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

// checkRateLimit is applied to /api/cron/* (10 calls/hour/path, module-scope in-memory fallback
// with no RATE_LIMIT_KV in the test env) — mocked to always allow, same pattern as
// tests/routes/cron-billing.test.ts, so the OI-278 guard suite's >10 sequential
// /delinquency-check requests don't trip the fixed window and 429 mid-file.
vi.mock('../../server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
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
  vi.stubGlobal('fetch', vi.fn())
})

describe('POST /api/cron/critical-dates-alerts', () => {
  const RECIPIENT = 'ggoldberg@oxfordra.net'
  const critRow = (reference_id: string, over: Row = {}): Row => ({
    date_type: 'lease_expiration', reference_id, tenant_name: 'Acme', property_name: 'REDACTED-020', suite: '101',
    critical_date: '2026-07-01', days_until: 26, urgency: 'urgent', ...over,
  })
  // OI-321: dedup is per (reference_id, urgency tier, critical date) — alert_tier + alert_date
  // (0019) — so an alert fires again as it escalates notice -> warning -> urgent -> overdue, and
  // again for a date edited in place (a lease extended by changing end_date).
  const sentRow = (reference_id: string, recipient = RECIPIENT, notification_type = 'critical_date_alert', alert_tier: string | null = 'urgent', alert_date: string | null = '2026-07-01'): Row =>
    ({ notification_type, reference_id, recipient, alert_tier, alert_date })
  function install(crit: ReturnType<typeof pgTable>, sent: ReturnType<typeof pgTable>) {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return crit
      if (table === 'sent_notifications') return sent
      return { select: vi.fn() }
    })
  }
  function post() {
    return app.request('/api/cron/critical-dates-alerts', { method: 'POST', headers: { Authorization: 'Bearer test' } }, env)
  }
  type Body = { new_alerts: number; skipped: number; email: { subject: string; body: string } | null; ack_token?: string | null; error?: string }
  const tokenAlerts = (b: Body) => (JSON.parse(b.ack_token!) as { v: number; alerts: [string, string, string][] }).alerts

  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/critical-dates-alerts', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('queries critical_dates and returns email: null and ack_token: null when no alerts due', async () => {
    install(pgTable([]), pgTable([]))
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    expect(body.new_alerts).toBe(0)
    expect(body.email).toBeNull()
    expect(body.ack_token).toBeNull()
  })

  it('returns a populated digest plus an ack_token, and records NOTHING before the send is confirmed (OI-321)', async () => {
    const sent = pgTable([])
    install(pgTable([critRow('lease_1')]), sent)

    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    expect(body.new_alerts).toBe(1)
    expect(body.skipped).toBe(0)
    // Pre-OI-321 the handler inserted the dedup rows here, so a failed Outlook send lost the
    // alerts for good. Rows are now written only by POST /critical-dates-alerts/ack.
    expect(sent.insert).not.toHaveBeenCalled()
    expect(sent.upsert).not.toHaveBeenCalled()
    expect(body.email!.subject).toContain('1 Critical Date')
    expect(body.email!.body).toContain('Acme')
    expect(body.email!.body).toContain('REDACTED-020')
    expect(JSON.parse(body.ack_token!)).toEqual({ v: 1, alerts: [['lease_1', 'urgent', '2026-07-01']] })
    // The token carries ids and tiers only, never tenant data.
    expect(body.ack_token).not.toContain('Acme')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('an alert that was never acked is re-reported by the next run (a failed send is not lost)', async () => {
    const sent = pgTable([])
    install(pgTable([critRow('lease_1')]), sent)
    expect((await (await post()).json() as Body).new_alerts).toBe(1)
    install(pgTable([critRow('lease_1')]), sent)
    expect((await (await post()).json() as Body).new_alerts).toBe(1)
  })

  it('skips alerts already acked at the same urgency tier', async () => {
    install(pgTable([critRow('lease_1')]), pgTable([sentRow('lease_1')]))
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    expect(body.new_alerts).toBe(0)
    expect(body.skipped).toBe(1)
    expect(body.email).toBeNull()
    expect(body.ack_token).toBeNull()
  })

  it('alerts again when the urgency tier escalates (OI-321: notice was sent, now urgent)', async () => {
    install(pgTable([critRow('lease_1', { urgency: 'urgent' })]), pgTable([sentRow('lease_1', RECIPIENT, 'critical_date_alert', 'notice')]))
    const body = await (await post()).json() as Body
    expect(body.new_alerts).toBe(1)
    expect(tokenAlerts(body)).toEqual([['lease_1', 'urgent', '2026-07-01']])
  })

  it('alerts again when the date moves (lease extended in place), even at an already-acked tier (OI-321)', async () => {
    // Acked at urgent for 2026-07-01; end_date then edited to 2026-08-01, still urgent. The dates
    // are deliberately in the past so they always pass the handler's real-clock 90-day horizon.
    install(pgTable([critRow('lease_1', { critical_date: '2026-08-01' })]), pgTable([sentRow('lease_1')]))
    const body = await (await post()).json() as Body
    expect(body.new_alerts).toBe(1)
    expect(tokenAlerts(body)).toEqual([['lease_1', 'urgent', '2026-08-01']])
  })

  it('a legacy row with no tier (pre-0019, not backfilled) does not suppress the alert', async () => {
    install(pgTable([critRow('lease_1')]), pgTable([sentRow('lease_1', RECIPIENT, 'critical_date_alert', null)]))
    expect((await (await post()).json() as Body).new_alerts).toBe(1)
  })

  it('does not treat a different notification_type for the same reference as already sent', async () => {
    install(pgTable([critRow('lease_1')]), pgTable([sentRow('lease_1', RECIPIENT, 'insurance_expiry')]))
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json() as Body).new_alerts).toBe(1)
  })

  it('digest lists alerts by urgency, then soonest first within an urgency', async () => {
    install(pgTable([
      critRow('ref_a', { tenant_name: 'Later', days_until: 50, urgency: 'warning' }),
      critRow('ref_b', { tenant_name: 'Sooner', days_until: 35, urgency: 'warning' }),
      critRow('ref_c', { tenant_name: 'Overdue', days_until: -3, urgency: 'overdue' }),
    ]), pgTable([]))
    const body = await (await post()).json() as Body
    const text = body.email!.body
    expect(text.indexOf('Overdue')).toBeLessThan(text.indexOf('Sooner'))
    expect(text.indexOf('Sooner')).toBeLessThan(text.indexOf('Later'))
  })

  it('fails closed (500, no digest, no token) on an urgency outside the four known tiers', async () => {
    // alert_tier has a CHECK constraint; an unknown tier could never be acked, so it would
    // re-alert every week forever. Contract drift in the view must surface, not loop.
    install(pgTable([critRow('lease_1', { urgency: 'someday' })]), pgTable([]))
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.json() as Body
    expect(body.error).toMatch(/urgency/)
    expect(body.email).toBeUndefined()
  })

  // PostgREST returns at most `max_rows` (supabase/config.toml, 1000) rows per request and
  // truncates SILENTLY. Each test is built so the pre-fix handler does the wrong thing against a
  // capped response — drops alerts, or re-reports already-acked ones — not merely so a length
  // check trips.
  describe('PostgREST max_rows truncation', () => {
    const refId = (i: number) => `ref_${String(i).padStart(5, '0')}`

    it('alerts on EVERY critical date when the view exceeds one PostgREST page (keyset-paged on reference_id, not truncated)', async () => {
      const ids = Array.from({ length: PG_MAX_ROWS + 1 }, (_, i) => refId(i))
      const crit = pgTable(ids.map(id => critRow(id)))
      install(crit, pgTable([]))

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.new_alerts).toBe(ids.length)
      expect(new Set(tokenAlerts(body).map(a => a[0]))).toEqual(new Set(ids))
      expect(crit.pages).toHaveLength(2)
      for (const page of crit.pages) {
        expect(page.find(c => c.method === 'order')?.args[0]).toBe('reference_id')
        expect(page.find(c => c.method === 'limit')?.args[0] as number).toBeLessThanOrEqual(PG_MAX_ROWS)
      }
    })

    it('fails closed (500, no digest) if a critical_dates page does not advance the reference_id cursor', async () => {
      const crit = pgTable(Array.from({ length: PG_MAX_ROWS }, (_, i) => critRow(refId(i))), { ignoreGt: 'reference_id' })
      install(crit, pgTable([]))

      const res = await post()
      expect(res.status).toBe(500)
      expect((await res.json() as Body).error).toMatch(/keyset page/)
      expect(crit.pages.length).toBeLessThanOrEqual(3)
    })

    it('never re-reports an already-acked alert when sent_notifications for the batch exceeds one page', async () => {
      // 300 dates already acked at this tier, each also carrying rows for a retired recipient and
      // two older tiers: the unfiltered read is 1200 rows, capped at 1000. Rows past the cap must
      // not read as unsent.
      const ids = Array.from({ length: 300 }, (_, i) => refId(i))
      const sentRows = [
        ...ids.map(id => sentRow(id, 'retired@oxfordra.net')),
        ...ids.map(id => sentRow(id, RECIPIENT, 'critical_date_alert', 'notice')),
        ...ids.map(id => sentRow(id, RECIPIENT, 'critical_date_alert', 'warning')),
        ...ids.map(id => sentRow(id)),
      ]
      const sent = pgTable(sentRows)
      install(pgTable(ids.map(id => critRow(id))), sent)

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.new_alerts).toBe(0)
      expect(body.skipped).toBe(ids.length)
      const idLists = sent.pages.map(p => p.find(c => c.method === 'in' && c.args[0] === 'reference_id')?.args[1] as unknown[])
      expect(idLists.length).toBeGreaterThan(1)
      for (const list of idLists) expect(list.length).toBeLessThanOrEqual(100)
    })

    it('fails closed (500, no email) when the sent_notifications dedup read errors', async () => {
      const sent = pgTable([], { error: { message: 'dedup read failed' } })
      install(pgTable([critRow('lease_1')]), sent)

      const res = await post()
      expect(res.status).toBe(500)
      const body = await res.json() as { error: string; email?: unknown }
      expect(body.error).toContain('dedup read failed')
      expect(body.email).toBeUndefined()
    })
  })
})

describe('POST /api/cron/critical-dates-alerts/ack (OI-321)', () => {
  const RECIPIENT = 'ggoldberg@oxfordra.net'
  const U1 = '11111111-1111-4111-8111-111111111111'
  const U2 = '22222222-2222-4222-8222-222222222222'
  const token = (alerts: unknown, v: unknown = 1) => JSON.stringify({ v, alerts })
  function ack(body: unknown, auth = true) {
    return app.request('/api/cron/critical-dates-alerts/ack', {
      method: 'POST',
      headers: { ...(auth ? { Authorization: 'Bearer test' } : {}), 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }, env)
  }
  function installSent(sent: ReturnType<typeof pgTable>) {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'sent_notifications') return sent
      return { select: vi.fn() }
    })
  }

  it('returns 401 without cron secret, and writes nothing', async () => {
    const sent = pgTable([])
    installSent(sent)
    const res = await ack({ ack_token: token([[U1, 'urgent', '2026-07-01']]) }, false)
    expect(res.status).toBe(401)
    expect(sent.upsert).not.toHaveBeenCalled()
  })

  it('records one dedup row per acked (reference_id, tier), idempotently', async () => {
    const sent = pgTable([])
    installSent(sent)
    const res = await ack({ ack_token: token([[U1, 'urgent', '2026-07-01'], [U2, 'notice', '2026-08-15']]) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recorded: 2 })
    expect(sent.upsert).toHaveBeenCalledTimes(1)
    expect(sent.upsert).toHaveBeenCalledWith(
      [
        { notification_type: 'critical_date_alert', reference_id: U1, recipient: RECIPIENT, alert_tier: 'urgent', alert_date: '2026-07-01' },
        { notification_type: 'critical_date_alert', reference_id: U2, recipient: RECIPIENT, alert_tier: 'notice', alert_date: '2026-08-15' },
      ],
      { onConflict: 'notification_type,reference_id,recipient,alert_tier,alert_date', ignoreDuplicates: true },
    )
  })

  it('chunks a large ack into bounded upserts', async () => {
    const sent = pgTable([])
    installSent(sent)
    const ids = Array.from({ length: 1201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const res = await ack({ ack_token: token(ids.map(id => [id, 'notice', '2026-07-01'])) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recorded: 1201 })
    const sizes = sent.upsert.mock.calls.map(c => (c[0] as unknown[]).length)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1201)
    for (const n of sizes) expect(n).toBeLessThanOrEqual(500)
  })

  it.each([
    ['a non-JSON body', 'not json'],
    ['no ack_token', {}],
    ['a non-string ack_token', { ack_token: 5 }],
    ['an ack_token that is not JSON', { ack_token: 'nope' }],
    ['an unknown token version', { ack_token: token([[U1, 'urgent', '2026-07-01']], 2) }],
    ['an empty alert list', { ack_token: token([]) }],
    ['a non-uuid reference_id', { ack_token: token([['lease_1', 'urgent', '2026-07-01']]) }],
    ['an unknown tier', { ack_token: token([[U1, 'someday', '2026-07-01']]) }],
    ['a pair without a date (pre-date token shape)', { ack_token: token([[U1, 'urgent']]) }],
    ['a malformed date', { ack_token: token([[U1, 'urgent', '2026-7-1']]) }],
    ['an impossible date', { ack_token: token([[U1, 'urgent', '2026-02-30']]) }],
    ['a malformed pair', { ack_token: token([[U1]]) }],
    ['more than 5000 alerts', { ack_token: token(Array.from({ length: 5001 }, () => [U1, 'urgent', '2026-07-01'])) }],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const sent = pgTable([])
    installSent(sent)
    const res = await ack(body)
    expect(res.status).toBe(400)
    expect(sent.upsert).not.toHaveBeenCalled()
  })

  it('returns 500 when the dedup write fails, so the caller reports the ack as failed', async () => {
    installSent(pgTable([], { upsert: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) }))
    const res = await ack({ ack_token: token([[U1, 'urgent', '2026-07-01']]) })
    expect(res.status).toBe(500)
    expect((await res.json() as { error: string }).error).toContain('boom')
  })

  it('round-trips: a token minted by /critical-dates-alerts is accepted by /ack', async () => {
    const sent = pgTable([])
    mockFrom.mockImplementation((table: string) => {
      if (table === 'critical_dates') return pgTable([{
        date_type: 'insurance_expiry', reference_id: U1, tenant_name: 'Acme', property_name: null, suite: null,
        critical_date: '2026-07-01', days_until: 50, urgency: 'warning',
      }])
      if (table === 'sent_notifications') return sent
      return { select: vi.fn() }
    })
    const first = await (await app.request('/api/cron/critical-dates-alerts', { method: 'POST', headers: { Authorization: 'Bearer test' } }, env)).json() as { ack_token: string }
    const res = await ack({ ack_token: first.ack_token })
    expect(res.status).toBe(200)
    expect(sent.upsert.mock.calls[0][0]).toEqual([{ notification_type: 'critical_date_alert', reference_id: U1, recipient: RECIPIENT, alert_tier: 'warning', alert_date: '2026-07-01' }])
  })
})

describe('POST /api/cron/delinquency-check', () => {
  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/delinquency-check', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('returns email: null when no delinquent leases', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'payments') return chainable([{ id: 'p' }]) // OI-278: feed live
      return chainable([])
    })

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
      if (table === 'payments') return chainable([{ id: 'p' }]) // OI-278: feed live
      if (table === 'ar_ledger') return chainable([{ lease_id: 'lease_1', tenant_id: 't1', tenant_name: 'Acme', property_name: null, suite: '101', balance: 1200 }])
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
      if (table === 'payments') return chainable([{ id: 'p' }]) // OI-278: feed live
      if (table === 'ar_ledger') return chainable([{ lease_id: 'lease_1', tenant_id: 't1', tenant_name: 'Acme', property_name: null, suite: '101', balance: 1200 }])
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
      if (table === 'payments') return chainable([{ id: 'p' }]) // OI-278: feed live
      if (table === 'ar_ledger') return chainable(arRows)
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

  // OI-278 (2026-09-12): the payments table had 0 rows EVER, so every ar_ledger balance was the
  // lifetime charge total and the endpoint posted 68 $50 late fees against tenants who had simply
  // never been recorded as paying. The handler must fail CLOSED when the payments feed is not
  // live — no QUALIFYING payment row (the same predicate ar_ledger's payment_totals applies:
  // check/wire/other always; ach_stripe only when stripe_status = 'succeeded') dated inside
  // [today − PAYMENTS_FEED_LOOKBACK_DAYS (45), today] — posting zero fees while still reporting
  // the delinquency counts, flagged `payments_feed_absent: true`, and ALWAYS returning a flagged
  // email (even with 0 delinquent leases) so ping-crons.ps1, which sends only when `email` is
  // non-null, actually notifies.
  describe('payments-feed guard (OI-278)', () => {
    const FEED_ABSENT_LEAD = 'PAYMENTS FEED ABSENT — delinquency not reliable; no late fees posted'

    function daysAgo(n: number): string {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    type PaymentRow = { payment_date: string; method: string; stripe_status?: string }

    // Minimal evaluator for the PostgREST logical-filter grammar the probe's `.or()` uses, so the
    // stub evaluates the handler's ACTUAL filter string against each fixture row rather than
    // re-implementing the predicate the test is supposed to be checking:
    //   expr := and(expr,...) | or(expr,...) | col.eq.value | col.in.(v1,v2,...)
    // Anything outside that grammar throws — a handler that emits a filter the stub can't
    // evaluate fails loudly instead of silently passing.
    function splitTopLevel(s: string): string[] {
      const parts: string[] = []
      let depth = 0
      let cur = ''
      for (const ch of s) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
      }
      if (cur) parts.push(cur)
      return parts
    }
    function evalFilter(expr: string, row: Record<string, unknown>): boolean {
      const logical = expr.match(/^(and|or)\((.*)\)$/)
      if (logical) {
        const results = splitTopLevel(logical[2]).map((p) => evalFilter(p, row))
        return logical[1] === 'and' ? results.every(Boolean) : results.some(Boolean)
      }
      const inList = expr.match(/^([a-z_]+)\.in\.\((.*)\)$/)
      if (inList) return row[inList[1]] != null && inList[2].split(',').includes(String(row[inList[1]]))
      const eq = expr.match(/^([a-z_]+)\.eq\.(.*)$/)
      if (eq) return row[eq[1]] != null && String(row[eq[1]]) === eq[2]
      throw new Error(`payments stub: unsupported filter expression "${expr}"`)
    }

    // `payments` stub: a builder that records every filter the handler chains (`.or`, `.gte`,
    // `.lte`) and applies ALL of them at `.limit()`, so each fixture proves the handler actually
    // emitted that filter — a stale row proves the lookback, a future row proves the upper bound,
    // a non-qualifying ach_stripe row proves the ar_ledger predicate. A range filter on a column
    // the row doesn't carry throws (a wrong column name must not pass as `'undefined' >= date`).
    function paymentsTable(rows: PaymentRow[], error: { message: string } | null = null) {
      const preds: ((r: PaymentRow) => boolean)[] = []
      const range = (col: string, cmp: (a: string, b: string) => boolean, v: string) => (r: PaymentRow) => {
        if (!(col in r)) throw new Error(`payments stub: range filter on unknown column "${col}"`)
        return cmp(String((r as Record<string, unknown>)[col]), v)
      }
      const builder = {
        select: vi.fn(() => builder),
        or: vi.fn((filters: string) => { preds.push((r) => evalFilter(`or(${filters})`, r)); return builder }),
        gte: vi.fn((col: string, v: string) => { preds.push(range(col, (a, b) => a >= b, v)); return builder }),
        lte: vi.fn((col: string, v: string) => { preds.push(range(col, (a, b) => a <= b, v)); return builder }),
        limit: vi.fn(async (n: number) => {
          if (error) return { data: null, error }
          return { data: rows.filter((r) => preds.every((p) => p(r))).slice(0, n).map(() => ({ id: 'p' })), error: null }
        }),
      }
      return builder
    }

    type ARRow = { lease_id: string; tenant_id: string; tenant_name: string; property_name: string | null; suite: string | null; balance: number }
    type InstallOpts = {
      paymentsError?: { message: string } | null
      // Default: one overdue, not-yet-fee'd AR row — the exact shape that posts a fee under a live feed.
      arRows?: ARRow[]
      overdue?: boolean // whether the AR row(s) are overdue under OI-234's oldest-first rule (recent charges < balance)
    }
    const ACME: ARRow = { lease_id: 'lease_1', tenant_id: 't1', tenant_name: 'Acme', property_name: null, suite: '101', balance: 1200 }

    function installDb(payments: PaymentRow[], insertSpy: ReturnType<typeof vi.fn>, opts: InstallOpts = {}) {
      const { paymentsError = null, arRows = [ACME], overdue = true } = opts
      let chargesCall = 0
      mockFrom.mockImplementation((table: string) => {
        if (table === 'payments') return paymentsTable(payments, paymentsError)
        if (table === 'ar_ledger') return chainable(arRows)
        if (table === 'charges') {
          chargesCall++
          // recent-charges sum (OI-234 oldest-first): no recent charges -> the whole balance is overdue;
          // recent charges equal to the balance -> nothing overdue.
          if (chargesCall === 1) return chainable(overdue ? [] : arRows.map((r) => ({ lease_id: r.lease_id, amount: r.balance })))
          if (chargesCall === 2) return chainable([])                                                           // no fee yet this period
          return { insert: insertSpy }
        }
        return { select: vi.fn() }
      })
    }

    type Body = { late_fees_posted: number; delinquent_count: number; payments_feed_absent: boolean; email: { subject: string; body: string } | null }

    function post() {
      return app.request('/api/cron/delinquency-check', { method: 'POST', headers: { Authorization: 'Bearer test' } }, env)
    }

    async function expectAbsent(insertSpy: ReturnType<typeof vi.fn>, delinquentCount: number) {
      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.payments_feed_absent).toBe(true)
      expect(body.late_fees_posted).toBe(0)
      expect(insertSpy).not.toHaveBeenCalled()
      expect(body.delinquent_count).toBe(delinquentCount)
      expect(body.email).not.toBeNull()
      expect(body.email!.subject.startsWith(FEED_ABSENT_LEAD)).toBe(true)
      expect(body.email!.body.startsWith(FEED_ABSENT_LEAD)).toBe(true)
      expect(body.email!.body).toContain('Late fees posted: 0')
      return body
    }

    async function expectLive(insertSpy: ReturnType<typeof vi.fn>) {
      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.payments_feed_absent).toBe(false)
      expect(body.late_fees_posted).toBe(1)
      expect(insertSpy).toHaveBeenCalledTimes(1)
      expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'late_fee', amount: 50, lease_id: 'lease_1' }))
      expect(body.delinquent_count).toBe(1)
      expect(body.email!.subject.startsWith('[ORA PM] 1 Delinquent Tenant')).toBe(true)
      expect(body.email!.subject).not.toContain(FEED_ABSENT_LEAD)
      expect(body.email!.body).not.toContain(FEED_ABSENT_LEAD)
      return body
    }

    it('posts ZERO late fees and flags payments_feed_absent when the payments table is empty', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([], insertSpy)

      const body = await expectAbsent(insertSpy, 1)
      // Delinquency is still REPORTED — only the money-moving side effect is withheld.
      expect(body.email!.subject).toContain('1 Delinquent Tenant')
      expect(body.email!.body).toContain('Acme')
    })

    it('treats a feed whose only qualifying payments are older than the lookback as absent', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(60), method: 'check' }, { payment_date: daysAgo(90), method: 'wire' }], insertSpy)
      await expectAbsent(insertSpy, 1)
    })

    it('posts late fees per the existing rules when a qualifying payment inside the lookback exists', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(10), method: 'check' }], insertSpy)
      await expectLive(insertSpy)
    })

    // Fix 1 (adversarial review, CRITICAL): liveness must use the SAME qualifying predicate as
    // ar_ledger's payment_totals (migration 0010/0011). Autopay inserts ach_stripe rows as
    // `processing` on the 1st (cron.ts monthly-billing) and the portal inserts intents as pending
    // (stripe.ts); if those later fail/return, total_paid stays 0 — a probe counting ANY row would
    // lift the guard and post fees against balances that never moved.
    it.each(['processing', 'failed', 'returned'])(
      'does NOT treat an ach_stripe row with stripe_status=%s inside the lookback as a live feed',
      async (stripeStatus) => {
        const insertSpy = vi.fn().mockResolvedValue({ error: null })
        installDb([{ payment_date: daysAgo(10), method: 'ach_stripe', stripe_status: stripeStatus }], insertSpy)
        await expectAbsent(insertSpy, 1)
      },
    )

    it('treats a succeeded ach_stripe row inside the lookback as a live feed', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(10), method: 'ach_stripe', stripe_status: 'succeeded' }], insertSpy)
      await expectLive(insertSpy)
    })

    it('treats a check row inside the lookback as a live feed regardless of stripe_status', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(10), method: 'check' }], insertSpy)
      await expectLive(insertSpy)
    })

    // Fix 2 (IMPORTANT): a future-dated typo must not lift the guard — the window is bounded above
    // by today, not open-ended.
    it('does NOT treat a single future-dated qualifying row as a live feed', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(-400), method: 'check' }], insertSpy)
      await expectAbsent(insertSpy, 1)
    })

    // Fix 4 (boundaries): the lookback is inclusive at exactly PAYMENTS_FEED_LOOKBACK_DAYS.
    it('treats a qualifying row dated exactly 45 days ago as live (inclusive lower bound)', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(45), method: 'check' }], insertSpy)
      await expectLive(insertSpy)
    })

    it('treats a qualifying row dated 46 days ago as absent', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(46), method: 'check' }], insertSpy)
      await expectAbsent(insertSpy, 1)
    })

    // Fix 3 (0-delinquent notification): ping-crons.ps1 sends ONLY when `email` is non-null, so an
    // absent feed must still produce a flagged email even when nothing is delinquent — otherwise
    // the operator never learns the feed is dead until something crosses the grace window.
    it('returns a flagged email when the feed is absent and no AR row is past the grace window', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([], insertSpy, { overdue: false })

      const body = await expectAbsent(insertSpy, 0)
      expect(body.email!.subject).toContain('0 Delinquent Tenants')
      expect(body.email!.body).not.toContain('Acme')
    })

    it('returns a flagged email when the feed is absent and the AR ledger has no positive balances (early return)', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([], insertSpy, { arRows: [] })

      const body = await expectAbsent(insertSpy, 0)
      expect(body.email!.subject).toContain('0 Delinquent Tenants')
    })

    it('keeps email: null for a live feed with 0 delinquent leases (unchanged behaviour)', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(10), method: 'check' }], insertSpy, { overdue: false })

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.payments_feed_absent).toBe(false)
      expect(body.late_fees_posted).toBe(0)
      expect(body.delinquent_count).toBe(0)
      expect(body.email).toBeNull()
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it('keeps email: null for a live feed with an empty AR ledger (unchanged behaviour)', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([{ payment_date: daysAgo(10), method: 'check' }], insertSpy, { arRows: [] })

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.payments_feed_absent).toBe(false)
      expect(body.email).toBeNull()
    })

    it('fails closed (HTTP 500, no fees) when the payments-feed probe itself errors', async () => {
      const insertSpy = vi.fn().mockResolvedValue({ error: null })
      installDb([], insertSpy, { paymentsError: { message: 'payments probe timeout' } })

      const res = await post()
      expect(res.status).toBe(500)
      const body = await res.json() as { error: string; email?: unknown }
      expect(body.error).toContain('payments probe timeout')
      expect(body.email).toBeUndefined()
      expect(insertSpy).not.toHaveBeenCalled()
    })
  })

  // PostgREST returns at most `max_rows` (supabase/config.toml, 1000) rows per request and
  // truncates SILENTLY. Each test is built so the pre-fix handler does the wrong thing against a
  // capped response — drops leases from the run, misses a late fee, or re-posts one — not merely
  // so a length check trips.
  describe('PostgREST max_rows truncation', () => {
    const today = new Date().toISOString().slice(0, 10)
    const OLD = '2020-01-15' // always past the 30-day grace cutoff
    const arRow = (lease_id: string, balance = 100): Row => ({ lease_id, tenant_id: `t_${lease_id}`, tenant_name: `Tenant ${lease_id}`, property_name: 'Prop', suite: lease_id, balance })
    // Unique, bytewise-ascending ids in creation order (charges.id is a uuid PK in production).
    let seq = 0
    const nextId = () => `c_${String(seq++).padStart(7, '0')}`
    // `voided_at: null` — live rows (migration 0016); the recent-charges query filters on it.
    const rentRow = (lease_id: string): Row => ({ id: nextId(), lease_id, type: 'base_rent', amount: 100, due_date: OLD, charge_date: OLD, voided_at: null })
    const feeRow = (lease_id: string): Row => ({ id: nextId(), lease_id, type: 'late_fee', amount: 50, due_date: today, charge_date: today, voided_at: null })
    const expectKeysetPages = (pages: Call[][], key: string) => {
      expect(pages.length).toBeGreaterThan(0)
      for (const page of pages) {
        expect(page.find(c => c.method === 'order')?.args[0]).toBe(key)
        const limit = page.find(c => c.method === 'limit')
        expect(limit).toBeDefined()
        expect(limit!.args[0] as number).toBeLessThanOrEqual(PG_MAX_ROWS)
      }
    }

    function install(ar: ReturnType<typeof pgTable>, charges: ReturnType<typeof pgTable>) {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'payments') return chainable([{ id: 'p' }]) // OI-278: feed live
        if (table === 'ar_ledger') return ar
        if (table === 'charges') return charges
        return { select: vi.fn() }
      })
    }
    function post() {
      return app.request('/api/cron/delinquency-check', { method: 'POST', headers: { Authorization: 'Bearer test' } }, env)
    }
    type Body = { late_fees_posted: number; delinquent_count: number; error?: string }

    it('evaluates EVERY positive-balance lease when the AR ledger exceeds one PostgREST page (paged, not truncated)', async () => {
      // Direction: a truncated ar_ledger fetch drops leases from the run — their late fees are
      // never posted and the digest under-reports, with a 200 and no error.
      const ids = Array.from({ length: PG_MAX_ROWS + 1 }, (_, i) => `lease_${String(i).padStart(5, '0')}`)
      const ar = pgTable(ids.map(id => arRow(id)))
      // Every lease overdue AND already fee'd this period, so no inserts — isolates the read path.
      const charges = pgTable([...ids.map(rentRow), ...ids.map(feeRow)])
      install(ar, charges)

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.delinquent_count).toBe(ids.length)
      expect(ar.pages).toHaveLength(2)
      expectKeysetPages(ar.pages, 'lease_id')
    })

    it('fails closed (500, nothing posted) if an AR ledger page does not advance the keyset cursor — never loops or double-counts', async () => {
      const ids = Array.from({ length: PG_MAX_ROWS }, (_, i) => `lease_${String(i).padStart(5, '0')}`)
      const insert = vi.fn().mockResolvedValue({ error: null })
      const ar = pgTable(ids.map(id => arRow(id)), { ignoreGt: 'lease_id' })
      install(ar, pgTable(ids.map(rentRow), { insert }))

      const res = await post()
      expect(res.status).toBe(500)
      expect(insert).not.toHaveBeenCalled()
      expect(ar.pages.length).toBeLessThanOrEqual(3)
    })

    it('fails closed (500, no fee) when the existing-fee chunk reaches the row cap — never re-posts a fee whose row was cut off', async () => {
      // Direction: DUPLICATE late fee attempt. lease_b was already fee'd this period, but its fee
      // row sits past row 1000; truncated, the pre-fix handler inserts a second fee (only the
      // idempotency_key unique index stands between that and a double charge).
      // The fee rows are dated so they are NOT "recent" (due_date past the cutoff): only the
      // existing-fee query can reach the cap, so the 500 is proven to come from its guard rather
      // than from the OI-234 recent-charges guard.
      const insert = vi.fn().mockResolvedValue({ error: null })
      const staleDueFee = (lease_id: string): Row => ({ ...feeRow(lease_id), due_date: OLD })
      const charges = pgTable([
        rentRow('lease_a'), rentRow('lease_b'),
        ...Array.from({ length: PG_MAX_ROWS }, () => staleDueFee('lease_a')),
        staleDueFee('lease_b'),
      ], { insert })
      install(pgTable([arRow('lease_a'), arRow('lease_b')]), charges)

      const res = await post()
      expect(insert).not.toHaveBeenCalled()
      expect(res.status).toBe(500)
      expect((await res.json() as Body).error).toMatch(/row cap/)
      const recentSelects = charges.pages.filter(p => p.some(c => c.method === 'gt' && c.args[0] === 'due_date'))
      expect(recentSelects.length).toBeGreaterThan(0) // the recent query ran and did not trip first
    })
  })
})
