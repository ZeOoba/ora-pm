import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

// ---------------------------------------------------------------------------
// Bypass admin auth (same pattern as tests/routes/notices.test.ts) — this
// file is testing cam.ts's own logic, not the admin gate.
// ---------------------------------------------------------------------------
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js — stateful, arg-aware mock (same style as
// tests/routes/cron-billing.test.ts).
//
// `state.rec` is the single cam_reconciliations row used by the approve
// tests. The conditional-update mock genuinely filters on `.eq('id', ...)`
// and `.eq('status', 'draft')` against this row and mutates it on a match —
// so a second approve() call against the SAME app instance really does see
// the first call's committed status flip, exactly like two sequential
// requests hitting a real Postgres row would.
//
// `state.charges` is a real in-memory charges table; the true-up insert
// dedupes by `idempotency_key`, mirroring the DB's unique constraint (a
// second insert with the same key resolves to a 23505 conflict rather than
// a second row) — this is what proves OI-046 is fixed: two approve() calls
// against the same reconciliation never leave two true-up charges behind.
// ---------------------------------------------------------------------------
const mockFrom = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom }) }))

type Row = Record<string, unknown>
type PgError = { code?: string; message: string }

const chargesInsertSpy = vi.fn()
const camUpsertSpy = vi.fn()

const state = {
  rec: null as Row | null,
  recSelectError: null as PgError | null,
  leaseUnits: { sf: 1000 } as Row | null,
  camEstimateCharges: [] as { amount: number }[],
  charges: [] as Row[],
  chargesInsertError: null as PgError | null,
  reconciliationUpdateError: null as PgError | null,
  listReconciliations: [] as Row[],
  listError: null as PgError | null,
  upsertResult: null as Row | null,
  upsertError: null as PgError | null,
}

function installDbMock() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'cam_reconciliations') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation(() => ({
            single: vi.fn().mockImplementation(async () => {
              if (state.recSelectError) return { data: null, error: state.recSelectError }
              if (!state.rec) return { data: null, error: { message: 'not found', code: 'PGRST116' } }
              return { data: state.rec, error: null }
            }),
          })),
          order: vi.fn().mockImplementation(async () => {
            if (state.listError) return { data: null, error: state.listError }
            return { data: state.listReconciliations, error: null }
          }),
        }),
        update: vi.fn().mockImplementation((patch: Row) => ({
          eq: vi.fn().mockImplementation((_col1: string, idVal: string) => ({
            eq: vi.fn().mockImplementation((_col2: string, statusVal: string) => ({
              select: vi.fn().mockImplementation(async () => {
                if (state.reconciliationUpdateError) {
                  return { data: null, error: state.reconciliationUpdateError }
                }
                if (!state.rec || state.rec.id !== idVal || state.rec.status !== statusVal) {
                  return { data: [], error: null } // conditional update matched zero rows
                }
                Object.assign(state.rec, patch)
                return { data: [state.rec], error: null }
              }),
            })),
          })),
        })),
        upsert: vi.fn().mockImplementation((row: Row) => {
          camUpsertSpy(row)
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockImplementation(async () => {
                if (state.upsertError) return { data: null, error: state.upsertError }
                return { data: state.upsertResult ?? { id: 'rec_new', ...row }, error: null }
              }),
            }),
          }
        }),
      }
    }
    if (table === 'leases') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockImplementation(async () => ({ data: { units: state.leaseUnits }, error: null })),
          }),
        }),
      }
    }
    if (table === 'charges') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gte: vi.fn().mockReturnValue({
                lte: vi.fn().mockImplementation(async () => ({ data: state.camEstimateCharges, error: null })),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockImplementation(async (row: Row) => {
          chargesInsertSpy(row)
          if (state.chargesInsertError) return { error: state.chargesInsertError }
          const dup = state.charges.some((c) => c.idempotency_key === row.idempotency_key)
          if (dup) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint "charges_idempotency_key_key"' } }
          }
          state.charges.push(row)
          return { error: null }
        }),
      }
    }
    return { select: vi.fn() }
  })
}

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
}

const app = createApp()

function approve(id: string) {
  return app.request(`/api/cam/${id}/approve`, { method: 'POST' }, env)
}

function calculate(body: unknown) {
  return app.request('/api/cam/calculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

const REC_ID = 'rec_1'
const LEASE_ID = 'lease_1'
const YEAR = 2025

function freshRec(overrides: Partial<Row> = {}): Row {
  return {
    id: REC_ID,
    lease_id: LEASE_ID,
    reconciliation_year: YEAR,
    true_up_amount: 500,
    status: 'draft',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.rec = freshRec()
  state.recSelectError = null
  state.leaseUnits = { sf: 1000 }
  state.camEstimateCharges = []
  state.charges = []
  state.chargesInsertError = null
  state.reconciliationUpdateError = null
  state.listReconciliations = []
  state.listError = null
  state.upsertResult = null
  state.upsertError = null
  installDbMock()
})

// ---------------------------------------------------------------------------
// POST /api/cam/:id/approve — atomic approval (OI-046)
// ---------------------------------------------------------------------------
describe('POST /api/cam/:id/approve', () => {
  it('returns 404 when the reconciliation does not exist', async () => {
    state.rec = null
    const res = await approve('nope')
    expect(res.status).toBe(404)
  })

  it('approves a draft reconciliation with a positive true-up: posts the charge and bills it', async () => {
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; true_up_amount: number }
    expect(body.success).toBe(true)
    expect(body.true_up_amount).toBe(500)
    expect(state.rec?.status).toBe('billed')
    expect(state.charges).toHaveLength(1)
  })

  // RED 1 — two approve calls against the same reconciliation must never
  // post the true-up charge twice, even though the insert-first pattern
  // means insert() is genuinely attempted on both calls (that's what makes
  // the 23505 idempotent-no-op path in RED 2 real, not dead code). The
  // load-bearing guarantee is on the PERSISTED result, not the raw call
  // count of the mock function.
  it('never double-posts the true-up charge across two approve calls on the same reconciliation', async () => {
    const res1 = await approve(REC_ID)
    expect(res1.status).toBe(200)

    const res2 = await approve(REC_ID)
    expect(res2.status).toBe(400)
    const body2 = await res2.json() as { error: string }
    expect(body2.error).toBe('already billed')

    const trueUps = state.charges.filter((c) => c.type === 'cam_true_up')
    expect(trueUps).toHaveLength(1)
  })

  // RED 2 — a 23505 on the true-up insert (simulating a concurrent request
  // that won the race) is an idempotent no-op, not an error: the status
  // update still runs and the call still reports success.
  it('treats a 23505 on the true-up insert as an idempotent no-op, not an error', async () => {
    state.chargesInsertError = { code: '23505', message: 'duplicate key value violates unique constraint "charges_idempotency_key_key"' }

    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; true_up_amount: number }
    expect(body.success).toBe(true)
    expect(body.true_up_amount).toBe(500)
    // Status update still ran despite the insert conflict.
    expect(state.rec?.status).toBe('billed')
  })

  // RED 3 — the true-up insert payload carries the documented idempotency key.
  it('posts the true-up charge with idempotency_key cam_true_up:<lease_id>:<year>', async () => {
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(chargesInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: `cam_true_up:${LEASE_ID}:${YEAR}` })
    )
  })

  it('applies the same conditional-update guard to the negative (credit) branch — no double-billing race', async () => {
    state.rec = freshRec({ true_up_amount: -75 })

    const res1 = await approve(REC_ID)
    expect(res1.status).toBe(200)
    const body1 = await res1.json() as { success: boolean }
    expect(body1.success).toBe(true)
    expect(state.rec?.status).toBe('billed')
    // Credits are never auto-posted as charges (Phase 1 limitation).
    expect(state.charges).toHaveLength(0)

    const res2 = await approve(REC_ID)
    expect(res2.status).toBe(400)
    const body2 = await res2.json() as { error: string }
    expect(body2.error).toBe('already billed')
  })

  it('does not touch charges or status for a balanced (zero) true-up', async () => {
    state.rec = freshRec({ true_up_amount: 0 })
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(state.charges).toHaveLength(0)
    expect(state.rec?.status).toBe('draft')
  })

  // RED 5 (approve variant) — a genuine (non-23505) DB error on the
  // conditional update must never leak the raw Postgres message.
  it('does not leak the raw Postgres error message when the status update genuinely fails', async () => {
    state.reconciliationUpdateError = { code: '23503', message: 'insert or update on table "cam_reconciliations" violates foreign key constraint "cam_reconciliations_lease_id_fkey"' }

    const res = await approve(REC_ID)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('foreign key constraint')
    expect(text).not.toContain('cam_reconciliations_lease_id_fkey')
  })
})

// ---------------------------------------------------------------------------
// POST /api/cam/calculate — validation (OI-041) + error hygiene (OI-042)
// ---------------------------------------------------------------------------
describe('POST /api/cam/calculate', () => {
  const VALID_BODY = {
    lease_id: '11111111-1111-1111-1111-111111111111',
    reconciliation_year: 2025,
    total_property_recoverable_expenses: 10000,
    total_leased_sf: 50000,
  }

  it('calculates and saves a CAM reconciliation for a valid body', async () => {
    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(200)
    expect(camUpsertSpy).toHaveBeenCalledTimes(1)
  })

  // RED 4 — a string where a number is required is rejected before any DB write.
  it('rejects a non-numeric total_leased_sf with 422 and never touches the DB', async () => {
    const res = await calculate({ ...VALID_BODY, total_leased_sf: 'abc' })
    expect(res.status).toBe(422)
    expect(camUpsertSpy).not.toHaveBeenCalled()
  })

  it('rejects a missing lease_id with 422', async () => {
    const { lease_id: _drop, ...rest } = VALID_BODY
    const res = await calculate(rest)
    expect(res.status).toBe(422)
    expect(camUpsertSpy).not.toHaveBeenCalled()
  })

  it('rejects a negative total_property_recoverable_expenses with 422', async () => {
    const res = await calculate({ ...VALID_BODY, total_property_recoverable_expenses: -1 })
    expect(res.status).toBe(422)
    expect(camUpsertSpy).not.toHaveBeenCalled()
  })

  // RED 5 — a genuine DB error on save must never leak the raw Postgres message.
  it('does not leak the raw Postgres error message when the save fails', async () => {
    state.upsertError = { code: '23503', message: 'insert or update on table "cam_reconciliations" violates foreign key constraint "cam_reconciliations_lease_id_fkey"' }

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('foreign key constraint')
    expect(text).not.toContain('cam_reconciliations_lease_id_fkey')
  })
})

// ---------------------------------------------------------------------------
// GET /api/cam — error hygiene (OI-042 sweep)
// ---------------------------------------------------------------------------
describe('GET /api/cam', () => {
  it('does not leak the raw Postgres error message on a list failure', async () => {
    state.listError = { code: '42P01', message: 'relation "cam_reconciliations" does not exist' }

    const res = await app.request('/api/cam', {}, env)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('relation "cam_reconciliations" does not exist')
  })
})
