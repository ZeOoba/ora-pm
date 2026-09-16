// tests/routes/payments.test.ts
//
// OI-082: POST /api/payments (manual check/wire/other entry) had no
// idempotency protection — migration 0011's two partial unique indexes on
// `payments` never apply to rows with NULL stripe_payment_intent_id / NULL
// autopay_period, i.e. every manual row. A double-submitted admin form, a
// retried request, or a re-run import wrote a duplicate row, and ar_ledger's
// payment_totals summed both, understating the balance that stripe.ts's
// amount cap and cron.ts's autopay lifetime cap both read.
//
// Migration 0015 adds payments.idempotency_key NOT NULL + UNIQUE
// (payments_idempotency_key_uniq). This route now mirrors charges.ts's
// OI-046 pattern: a client-supplied key passes through unchanged (the admin
// form sends one stable key per form session, so a retry/double-submit
// resends the same value), otherwise the server defaults manual:<uuid>. A
// 23505 scoped to payments_idempotency_key_uniq is reported as "already
// recorded" (409) rather than a generic failure; every other DB error stays
// a generic 500 via dbError (no raw Postgres text to the client).

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
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const LEASE_ID = '33333333-3333-3333-3333-333333333333'

const VALID = {
  lease_id: LEASE_ID,
  payment_date: '2026-09-01',
  amount: 3500,
  method: 'check',
  check_number: '10457',
  notes: 'September base rent',
}

type PgError = { code: string; message: string }

// In-memory `payments` table that enforces the 0015 unique index the way
// Postgres does: a second insert with an idempotency_key already present
// resolves to a 23505 naming payments_idempotency_key_uniq. `insertError`
// forces a fixed error for the non-conflict branches.
function paymentsTable(state: { rows: Record<string, unknown>[]; insertError?: PgError }) {
  const insert = vi.fn().mockImplementation((row: Record<string, unknown>) => {
    let error: PgError | null = null
    if (state.insertError) {
      error = state.insertError
    } else if (state.rows.some((r) => r.idempotency_key === row.idempotency_key)) {
      error = { code: '23505', message: 'duplicate key value violates unique constraint "payments_idempotency_key_uniq"' }
    } else {
      state.rows.push({ id: `row_${state.rows.length + 1}`, ...row })
    }
    const inserted = state.rows[state.rows.length - 1]
    return {
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue(error ? { data: null, error } : { data: inserted, error: null }),
      }),
    }
  })
  return { insert }
}

function post(body: unknown) {
  return app.request('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

describe('POST /api/payments — idempotency_key (OI-082)', () => {
  let state: { rows: Record<string, unknown>[]; insertError?: PgError }
  let table: ReturnType<typeof paymentsTable>

  beforeEach(() => {
    state = { rows: [] }
    table = paymentsTable(state)
    mockFrom.mockImplementation((name: string) => {
      if (name !== 'payments') throw new Error(`unexpected table ${name}`)
      return table
    })
  })

  // RED — fails today: the route inserts parsed.data verbatim, which carries
  // no idempotency_key, so against the 0015 schema every manual insert would
  // violate NOT NULL.
  it('defaults idempotency_key to manual:<uuid> when the client omits it', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(201)
    expect(table.insert).toHaveBeenCalledTimes(1)
    const inserted = table.insert.mock.calls[0][0] as { idempotency_key: string }
    expect(inserted.idempotency_key).toMatch(/^manual:[0-9a-f-]{36}$/)
  })

  it('passes a client-supplied idempotency_key through unchanged', async () => {
    const res = await post({ ...VALID, idempotency_key: 'manual:form-session-1' })
    expect(res.status).toBe(201)
    const inserted = table.insert.mock.calls[0][0] as { idempotency_key: string }
    expect(inserted.idempotency_key).toBe('manual:form-session-1')
  })

  it('rejects an empty idempotency_key with 422 (it would be a useless dedupe token, not a NULL)', async () => {
    const res = await post({ ...VALID, idempotency_key: '' })
    expect(res.status).toBe(422)
    expect(table.insert).not.toHaveBeenCalled()
  })

  it('two omitted-key calls each get a distinct generated key (no accidental collision between legit repeat payments)', async () => {
    await post(VALID)
    await post(VALID)
    const k1 = (table.insert.mock.calls[0][0] as { idempotency_key: string }).idempotency_key
    const k2 = (table.insert.mock.calls[1][0] as { idempotency_key: string }).idempotency_key
    expect(k1).not.toBe(k2)
    expect(state.rows).toHaveLength(2)
  })

  // RED — the bug: a double-submitted/retried form resending the same key
  // must NOT land a second row, and must be told so clearly instead of a
  // generic failure.
  it('a resubmission with the same idempotency_key is reported as already recorded (409) and inserts nothing', async () => {
    const first = await post({ ...VALID, idempotency_key: 'manual:form-session-1' })
    expect(first.status).toBe(201)
    const second = await post({ ...VALID, idempotency_key: 'manual:form-session-1' })
    expect(second.status).toBe(409)
    const json = await second.json() as { error: string; deduped?: boolean }
    expect(json.error).toMatch(/already recorded/i)
    expect(json.error).not.toMatch(/payments_idempotency_key_uniq|duplicate key value/)
    expect(json.deduped).toBe(true)
    expect(state.rows).toHaveLength(1)
  })

  it('a 23505 from a DIFFERENT constraint is NOT misreported as already recorded (stays a generic 500)', async () => {
    state.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "payments_autopay_period_uniq"' }
    const res = await post({ ...VALID, idempotency_key: 'manual:form-session-1' })
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('Failed to create payment')
    expect(json.error).not.toMatch(/payments_autopay_period_uniq/)
  })

  it('a non-conflict DB error returns a generic 500 message, never the raw Postgres error (OI-042 hygiene)', async () => {
    state.insertError = { code: '23502', message: 'null value in column "idempotency_key" violates not-null constraint' }
    const res = await post(VALID)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('Failed to create payment')
    expect(json.error).not.toMatch(/not-null|idempotency_key/)
  })
})
