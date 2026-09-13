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
    date_type: 'lease_expiration', reference_id, tenant_name: 'Acme', property_name: '9050 Red Branch', suite: '101',
    critical_date: '2026-07-01', days_until: 26, urgency: 'urgent', ...over,
  })
  const sentRow = (reference_id: string, recipient = RECIPIENT, notification_type = 'critical_date_alert'): Row =>
    ({ notification_type, reference_id, recipient })
  // Enforces UNIQUE(notification_type, reference_id, recipient) (0003_operations_tables.sql) against
  // `existing`, so a handler that re-inserts an already-sent row gets the production error back.
  const uniqueInsert = (existing: Row[]) => vi.fn().mockImplementation((rows: Row[]) => {
    const key = (r: Row) => `${r.notification_type}|${r.reference_id}|${r.recipient}`
    const have = new Set(existing.map(key))
    const dup = rows.find(r => have.has(key(r)))
    return Promise.resolve({ error: dup ? { message: `duplicate key value violates unique constraint (${key(dup)})` } : null })
  })
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
  type Body = { new_alerts: number; skipped: number; email: { subject: string; body: string } | null; error?: string }

  it('returns 401 without cron secret', async () => {
    const res = await app.request('/api/cron/critical-dates-alerts', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('queries critical_dates and returns email: null when no alerts due', async () => {
    install(pgTable([]), pgTable([]))
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    expect(body.new_alerts).toBe(0)
    expect(body.email).toBeNull()
  })

  it('records new alerts and returns a populated email digest, not a Resend call', async () => {
    const sent = pgTable([])
    install(pgTable([critRow('lease_1')]), sent)

    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    expect(body.new_alerts).toBe(1)
    expect(body.skipped).toBe(0)
    // Proves the handler called insert with the right dedup rows before
    // returning this response — it does NOT by itself prove the insert
    // resolved before the digest was built (that ordering is proven by the
    // separate "never returns email content when the dedup write fails"
    // test below, which shows no digest is returned when the insert fails).
    expect(sent.insert).toHaveBeenCalledWith([
      { notification_type: 'critical_date_alert', reference_id: 'lease_1', recipient: RECIPIENT },
    ])
    expect(body.email).not.toBeNull()
    expect(body.email!.subject).toContain('1 Critical Date')
    expect(body.email!.body).toContain('Acme')
    expect(body.email!.body).toContain('9050 Red Branch')
    // Resend is gone — no fetch of any kind from this handler anymore.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips alerts already sent to the (single) recipient', async () => {
    install(pgTable([critRow('lease_1')]), pgTable([sentRow('lease_1')]))
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json() as Body
    expect(body.new_alerts).toBe(0)
    expect(body.skipped).toBe(1)
    expect(body.email).toBeNull()
  })

  it('does not treat a different notification_type for the same reference as already sent', async () => {
    // UNIQUE is (notification_type, reference_id, recipient): an insurance_expiry row for this id
    // neither blocks the insert nor means a critical-date alert went out.
    const sent = pgTable([sentRow('lease_1', RECIPIENT, 'insurance_expiry')])
    install(pgTable([critRow('lease_1')]), sent)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json() as Body).new_alerts).toBe(1)
    expect(sent.insert).toHaveBeenCalledTimes(1)
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

  it('never returns email content when the dedup write fails', async () => {
    install(pgTable([critRow('lease_1')]), pgTable([], { insert: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) }))
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string; email?: unknown }
    expect(body.error).toContain('boom')
    expect(body.email).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  // PostgREST returns at most `max_rows` (supabase/config.toml, 1000) rows per request and
  // truncates SILENTLY. Each test is built so the pre-fix handler does the wrong thing against a
  // capped response — drops alerts, or re-inserts a dedup row and 500s — not merely so a length
  // check trips.
  describe('PostgREST max_rows truncation', () => {
    const refId = (i: number) => `ref_${String(i).padStart(5, '0')}`

    it('alerts on EVERY critical date when the view exceeds one PostgREST page (keyset-paged on reference_id, not truncated)', async () => {
      // Direction: DROPPED alerts. critical_dates has no lower date bound, so overdue history
      // accumulates; past row 1000 the pre-fix handler never alerts on the rest, with a 200.
      const ids = Array.from({ length: PG_MAX_ROWS + 1 }, (_, i) => refId(i))
      const crit = pgTable(ids.map(id => critRow(id)))
      const sent = pgTable([])
      install(crit, sent)

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.new_alerts).toBe(ids.length)
      const inserted = sent.insert.mock.calls.flatMap(c => c[0] as Row[]).map(r => r.reference_id)
      expect(new Set(inserted)).toEqual(new Set(ids))
      expect(crit.pages).toHaveLength(2)
      for (const page of crit.pages) {
        expect(page.find(c => c.method === 'order')?.args[0]).toBe('reference_id')
        expect(page.find(c => c.method === 'limit')?.args[0] as number).toBeLessThanOrEqual(PG_MAX_ROWS)
      }
    })

    it('fails closed (500, nothing recorded) if a critical_dates page does not advance the reference_id cursor', async () => {
      const crit = pgTable(Array.from({ length: PG_MAX_ROWS }, (_, i) => critRow(refId(i))), { ignoreGt: 'reference_id' })
      const sent = pgTable([])
      install(crit, sent)

      const res = await post()
      expect(res.status).toBe(500)
      expect((await res.json() as Body).error).toMatch(/keyset page/)
      expect(sent.insert).not.toHaveBeenCalled()
      expect(crit.pages.length).toBeLessThanOrEqual(3)
    })

    it('never re-inserts an already-sent dedup row when sent_notifications for the batch exceeds one page', async () => {
      // Direction: PERMANENT 500. 600 dates already alerted, but each id also carries a row for a
      // retired recipient, so the unfiltered pre-fix read returns 1200 rows, capped at 1000. The
      // current recipient's rows past the cap read as unsent -> re-inserted -> UNIQUE violation ->
      // 500 on every run from then on.
      const ids = Array.from({ length: 600 }, (_, i) => refId(i))
      const sentRows = [...ids.map(id => sentRow(id, 'retired@oxfordra.net')), ...ids.map(id => sentRow(id))]
      const sent = pgTable(sentRows, { insert: uniqueInsert(sentRows) })
      install(pgTable(ids.map(id => critRow(id))), sent)

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.new_alerts).toBe(0)
      expect(body.skipped).toBe(ids.length)
      expect(sent.insert).not.toHaveBeenCalled()
      // Chunked: no single `.in('reference_id', ...)` carries an unbounded id list (URL length).
      const idLists = sent.pages.map(p => p.find(c => c.method === 'in' && c.args[0] === 'reference_id')?.args[1] as unknown[])
      expect(idLists.length).toBeGreaterThan(1)
      for (const list of idLists) expect(list.length).toBeLessThanOrEqual(100)
    })

    it('fails closed (500, nothing recorded, no email) when the sent_notifications dedup read errors', async () => {
      // Pre-fix the error was never checked: every alert read as unsent and was re-inserted.
      const sent = pgTable([], { error: { message: 'dedup read failed' } })
      install(pgTable([critRow('lease_1')]), sent)

      const res = await post()
      expect(res.status).toBe(500)
      const body = await res.json() as { error: string; email?: unknown }
      expect(body.error).toContain('dedup read failed')
      expect(body.email).toBeUndefined()
      expect(sent.insert).not.toHaveBeenCalled()
    })
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
        // Call 1: bulk overdue check -> lease_1 IS overdue. Call 2: bulk existing-fee check ->
        // no fee posted yet this period. Call 3: the insert itself.
        if (chargesCall === 1) return chainable([{ lease_id: 'lease_1' }])
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
    mockFrom.mockImplementation((table: string) => {
      if (table === 'payments') return chainable([{ id: 'p' }]) // OI-278: feed live
      if (table === 'ar_ledger') return chainable([{ lease_id: 'lease_1', tenant_id: 't1', tenant_name: 'Acme', property_name: null, suite: '101', balance: 1200 }])
      // Both bulk lookups (overdue check, existing-fee check) report lease_1 as a hit — already
      // overdue AND already fee'd this period — so the insert branch (a 3rd `.from('charges')`
      // call) should never fire.
      if (table === 'charges') return chainable([{ lease_id: 'lease_1' }])
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
        // Every bulk lookup reports every lease as overdue AND already fee'd this period, so the
        // insert branch is never reached — isolates the SELECT-side N+1 fix from insert-call count.
        // `id`: the overdue probe is keyset-paged on charges.id, which must be ascending.
        return chainable(arRows.map((r, i) => ({ id: `c_${String(i).padStart(7, '0')}`, lease_id: r.lease_id })))
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
      overdue?: boolean // whether the bulk overdue lookup reports the AR row(s) as past GRACE_DAYS
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
          if (chargesCall === 1) return chainable(overdue ? arRows.map((r, i) => ({ id: `c_${String(i).padStart(7, '0')}`, lease_id: r.lease_id })) : []) // overdue lookup
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
    const rentRow = (lease_id: string): Row => ({ id: nextId(), lease_id, type: 'base_rent', amount: 100, due_date: OLD, charge_date: OLD })
    const feeRow = (lease_id: string): Row => ({ id: nextId(), lease_id, type: 'late_fee', amount: 50, due_date: today, charge_date: today })
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

    it('pages the overdue-charges probe inside a chunk — a lease whose overdue charge is past row 1000 is still fined, not skipped and not a 500', async () => {
      // Direction: MISSED late fee. lease_a's 1000 historical charges fill the capped response, so
      // lease_b's overdue charge (row 1001) is cut off and the pre-fix handler never fines lease_b
      // while posting lease_a's fee and returning 200. Long billing histories are NORMAL (every
      // charge dated <= cutoff matches), so this probe must be complete, not merely fail closed.
      const insert = vi.fn().mockResolvedValue({ error: null })
      const charges = pgTable([...Array.from({ length: PG_MAX_ROWS }, () => rentRow('lease_a')), rentRow('lease_b')], { insert })
      install(pgTable([arRow('lease_a'), arRow('lease_b')]), charges)

      const res = await post()
      expect(res.status).toBe(200)
      const body = await res.json() as Body
      expect(body.late_fees_posted).toBe(2)
      expect(insert).toHaveBeenCalledWith(expect.objectContaining({ lease_id: 'lease_b', type: 'late_fee' }))
      const overduePages = charges.pages.filter(p => p.some(c => c.method === 'lte' && c.args[0] === 'due_date'))
      expect(overduePages).toHaveLength(2)
      expectKeysetPages(overduePages, 'id')
    })

    it('fails closed (500, no fee) if an overdue-charges page does not advance the charges.id cursor', async () => {
      // The paged probe's own failure path: a cursor-ignoring page must surface as a 500 through
      // fetchChunked, never be swallowed into "no overdue charges" (which would fine nobody, 200).
      const insert = vi.fn().mockResolvedValue({ error: null })
      const charges = pgTable([...Array.from({ length: PG_MAX_ROWS }, () => rentRow('lease_a')), rentRow('lease_b')], { insert, ignoreGt: 'id' })
      install(pgTable([arRow('lease_a'), arRow('lease_b')]), charges)

      const res = await post()
      expect(res.status).toBe(500)
      expect(insert).not.toHaveBeenCalled()
      expect((await res.json() as Body).error).toMatch(/keyset page/)
      expect(charges.pages.length).toBeLessThanOrEqual(4)
    })

    it('fails closed (500, no fee) when the existing-fee chunk reaches the row cap — never re-posts a fee whose row was cut off', async () => {
      // Direction: DUPLICATE late fee attempt. lease_b was already fee'd this period, but its fee
      // row sits past row 1000; truncated, the pre-fix handler inserts a second fee (only the
      // idempotency_key unique index stands between that and a double charge).
      const insert = vi.fn().mockResolvedValue({ error: null })
      const charges = pgTable([
        rentRow('lease_a'), rentRow('lease_b'),
        ...Array.from({ length: PG_MAX_ROWS }, () => feeRow('lease_a')),
        feeRow('lease_b'),
      ], { insert })
      install(pgTable([arRow('lease_a'), arRow('lease_b')]), charges)

      const res = await post()
      expect(insert).not.toHaveBeenCalled()
      expect(res.status).toBe(500)
      expect((await res.json() as Body).error).toMatch(/row cap/)
    })
  })
})
