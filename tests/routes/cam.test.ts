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
// `state.rec` is the single cam_reconciliations row in play. Both the
// SELECT and UPDATE chains genuinely filter on whatever `.eq()`/`.neq()`
// predicates the route code calls against this row and mutate it on a
// match — so a second approve() or calculate() call against the SAME app
// instance really does see the first call's committed state, exactly like
// two sequential requests hitting a real Postgres row would. The INSERT
// chain enforces the same (lease_id, reconciliation_year) uniqueness the
// real DB constraint does, surfacing a 23505 on conflict.
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
type Predicate = { col: string; val: unknown; op: 'eq' | 'neq' }

function matchesAll(rec: Row | null, predicates: Predicate[]): boolean {
  if (!rec) return false
  return predicates.every((p) => (p.op === 'eq' ? rec[p.col] === p.val : rec[p.col] !== p.val))
}

const chargesInsertSpy = vi.fn()
const camUpdateSpy = vi.fn()
const camInsertSpy = vi.fn()

const state = {
  rec: null as Row | null,
  recSelectError: null as PgError | null,
  leaseUnits: { sf: 1000 } as Row | null,
  leaseRentType: 'nnn' as string,
  leaseExpenseStop: null as number | null,
  camEstimateCharges: [] as { amount: number; voided_at?: string | null }[],
  camChargesError: null as PgError | null,
  leaseSelectError: null as PgError | null,
  charges: [] as Row[],
  chargesInsertError: null as PgError | null,
  reconciliationUpdateError: null as PgError | null,
  camInsertError: null as PgError | null,
  listReconciliations: [] as Row[],
  listError: null as PgError | null,
}

function installDbMock() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'cam_reconciliations') {
      return {
        // Generic SELECT chain: accumulates `.eq()` predicates, terminates
        // in `.single()` (used by /:id/approve — 404s on no match) or
        // `.maybeSingle()` (used by /calculate's existing-row check —
        // `{data:null,error:null}` on no match, never an error).
        select: vi.fn().mockImplementation(() => {
          function chain(predicates: Predicate[]): Row {
            return {
              eq: (col: string, val: unknown) => chain([...predicates, { col, val, op: 'eq' as const }]),
              single: vi.fn().mockImplementation(async () => {
                if (state.recSelectError) return { data: null, error: state.recSelectError }
                if (!matchesAll(state.rec, predicates)) {
                  return { data: null, error: { message: 'not found', code: 'PGRST116' } }
                }
                return { data: state.rec, error: null }
              }),
              maybeSingle: vi.fn().mockImplementation(async () => {
                if (state.recSelectError) return { data: null, error: state.recSelectError }
                if (!matchesAll(state.rec, predicates)) return { data: null, error: null }
                return { data: { status: (state.rec as Row).status }, error: null }
              }),
            }
          }
          return chain([])
        }),
        order: vi.fn().mockImplementation(async () => {
          if (state.listError) return { data: null, error: state.listError }
          return { data: state.listReconciliations, error: null }
        }),
        // Generic conditional-UPDATE chain: accumulates `.eq()`/`.neq()`
        // predicates, `.select()` mutates + returns [state.rec] only if
        // ALL predicates match — zero rows otherwise (the atomic
        // compare-and-swap both OI-046's /:id/approve and OI-069's
        // /calculate rely on).
        update: vi.fn().mockImplementation((patch: Row) => {
          camUpdateSpy(patch)
          function chain(predicates: Predicate[]): Row {
            return {
              eq: (col: string, val: unknown) => chain([...predicates, { col, val, op: 'eq' as const }]),
              neq: (col: string, val: unknown) => chain([...predicates, { col, val, op: 'neq' as const }]),
              select: vi.fn().mockImplementation(async () => {
                if (state.reconciliationUpdateError) return { data: null, error: state.reconciliationUpdateError }
                if (!matchesAll(state.rec, predicates)) return { data: [], error: null }
                Object.assign(state.rec as Row, patch)
                return { data: [state.rec], error: null }
              }),
            }
          }
          return chain([])
        }),
        // INSERT enforces the same (lease_id, reconciliation_year)
        // uniqueness the real DB constraint does — inserting into an
        // existing lease/year surfaces a 23505, exactly like Postgres.
        insert: vi.fn().mockImplementation((row: Row) => {
          camInsertSpy(row)
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockImplementation(async () => {
                if (state.camInsertError) return { data: null, error: state.camInsertError }
                if (
                  state.rec &&
                  state.rec.lease_id === row.lease_id &&
                  state.rec.reconciliation_year === row.reconciliation_year
                ) {
                  return {
                    data: null,
                    error: {
                      code: '23505',
                      message: 'duplicate key value violates unique constraint '
                        + '"cam_reconciliations_lease_id_reconciliation_year_key"',
                    },
                  }
                }
                const newRec = { id: 'rec_new', ...row }
                state.rec = newRec
                return { data: newRec, error: null }
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
            single: vi.fn().mockImplementation(async () => (
              state.leaseSelectError
                ? { data: null, error: state.leaseSelectError }
                : { data: { units: state.leaseUnits, rent_type: state.leaseRentType, expense_stop_amount: state.leaseExpenseStop }, error: null }
            )),
          }),
        }),
      }
    }
    if (table === 'charges') {
      return {
        // /calculate's estimated-CAM-paid sum:
        //   .eq('lease_id').eq('type','cam_estimate').is('voided_at', null).gte(period_start).lte(period_end)
        // OI-278 / migration 0016: the `.is('voided_at', null)` link is applied for real — a voided
        // estimate row must not count as CAM already paid (it would understate the true-up).
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockImplementation((col: string, val: unknown) => ({
                gte: vi.fn().mockReturnValue({
                  lte: vi.fn().mockImplementation(async () => (
                    state.camChargesError
                      ? { data: null, error: state.camChargesError }
                      : {
                          data: col === 'voided_at' && val === null
                            ? state.camEstimateCharges.filter((c) => (c.voided_at ?? null) === null)
                            : state.camEstimateCharges,
                          error: null,
                        }
                  )),
                }),
              })),
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
  state.leaseRentType = 'nnn'
  state.leaseExpenseStop = null
  state.camEstimateCharges = []
  state.camChargesError = null
  state.leaseSelectError = null
  state.charges = []
  state.chargesInsertError = null
  state.reconciliationUpdateError = null
  state.camInsertError = null
  state.listReconciliations = []
  state.listError = null
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

  it('calculates and saves a CAM reconciliation for a valid body (first-ever calculation)', async () => {
    // Default state.rec (from beforeEach) has a DIFFERENT lease_id than
    // VALID_BODY — simulates "no existing row for this lease/year": the
    // conditional UPDATE matches zero rows, falls through to INSERT.
    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(200)
    expect(camUpdateSpy).toHaveBeenCalledTimes(1) // attempted first, matched nothing
    expect(camInsertSpy).toHaveBeenCalledTimes(1) // fell through, succeeded
    const json = await res.json() as { data: Row }
    expect(json.data.lease_id).toBe(VALID_BODY.lease_id)
    expect(json.data.status).toBe('draft')
  })

  // OI-278 / migration 0016: estimated_cam_paid is Σ cam_estimate charges for the year. A voided
  // estimate is not money the tenant was billed, so it must not reduce the true-up owed.
  it('excludes voided cam_estimate charges from estimated_cam_paid', async () => {
    state.camEstimateCharges = [
      { amount: 100 },
      { amount: 100, voided_at: '2026-09-13T12:00:00Z' },
    ]
    // tenantSF 1000 / totalLeasedSF 50000 = 2% × $10,000 = $200 owed; $100 paid (not $200).
    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Row }
    expect(json.data.estimated_cam_paid).toBe(100)
    expect(json.data.true_up_amount).toBe(100)
  })

  // PR #42 refute (Important 1): the estimated-CAM-paid read used to discard its `error`, so a
  // failed query (e.g. 42703 while the app is deployed ahead of migration 0016's `voided_at`
  // column) read as estimated_cam_paid = 0 — overstating true_up_amount and SAVING a draft that
  // /approve would then post. Fail closed like every other charges reader: 500, nothing written,
  // no raw Postgres text.
  it('returns 500 and saves nothing when the cam_estimate charges read fails (never a $0-paid draft)', async () => {
    state.camChargesError = { code: '42703', message: 'column charges.voided_at does not exist' }

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(500)
    expect(camUpdateSpy).not.toHaveBeenCalled()
    expect(camInsertSpy).not.toHaveBeenCalled()
    const text = await res.text()
    expect(text).not.toContain('voided_at')
    expect(text).not.toContain('42703')
  })

  it('returns 500 and saves nothing when the lease/unit SF read fails (never a 0-SF pro-rata draft)', async () => {
    state.leaseSelectError = { code: '57014', message: 'canceling statement due to statement timeout on relation "leases"' }

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(500)
    expect(camUpdateSpy).not.toHaveBeenCalled()
    expect(camInsertSpy).not.toHaveBeenCalled()
    expect(await res.text()).not.toContain('statement timeout')
  })

  // PR #42 review finding, CONFIRMED: a genuinely missing lease (PGRST116) used to be swallowed —
  // execution fell through with tenantSF defaulted to 0, computed a true-up against a nonexistent
  // lease, and only failed later (generically, via the cam_reconciliations FK constraint on
  // insert) as an unrelated 500. Must 404 immediately instead, and never compute or save anything.
  it('returns 404 and saves nothing when the lease does not exist (PGRST116), not a 0-SF true-up', async () => {
    state.leaseSelectError = { code: 'PGRST116', message: 'not found' }

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(404)
    expect(camUpdateSpy).not.toHaveBeenCalled()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  // RED 4 — a string where a number is required is rejected before any DB write.
  it('rejects a non-numeric total_leased_sf with 422 and never touches the DB', async () => {
    const res = await calculate({ ...VALID_BODY, total_leased_sf: 'abc' })
    expect(res.status).toBe(422)
    expect(camUpdateSpy).not.toHaveBeenCalled()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('rejects a missing lease_id with 422', async () => {
    const { lease_id: _drop, ...rest } = VALID_BODY
    const res = await calculate(rest)
    expect(res.status).toBe(422)
    expect(camUpdateSpy).not.toHaveBeenCalled()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('rejects a negative total_property_recoverable_expenses with 422', async () => {
    const res = await calculate({ ...VALID_BODY, total_property_recoverable_expenses: -1 })
    expect(res.status).toBe(422)
    expect(camUpdateSpy).not.toHaveBeenCalled()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  // RED 5 — a genuine DB error on the insert fallback must never leak the
  // raw Postgres message.
  it('does not leak the raw Postgres error message when the insert genuinely fails', async () => {
    state.camInsertError = { code: '23503', message: 'insert or update on table "cam_reconciliations" violates foreign key constraint "cam_reconciliations_lease_id_fkey"' }

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('foreign key constraint')
    expect(text).not.toContain('cam_reconciliations_lease_id_fkey')
  })

  it('does not leak the raw Postgres error message when the conditional update genuinely fails', async () => {
    state.rec = freshRec({
      lease_id: VALID_BODY.lease_id,
      reconciliation_year: VALID_BODY.reconciliation_year,
      status: 'draft',
    })
    state.reconciliationUpdateError = { code: '53300', message: 'too many connections for role "cam_reconciliations_writer"' }

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('cam_reconciliations_writer')
  })

  // ---------------------------------------------------------------------------
  // OI-069 — recalculating an already-billed reconciliation must not silently
  // reopen it. Before this fix: /calculate's upsert unconditionally reset
  // status to 'draft' even if it was 'billed', so a later /approve posted a
  // NEW true-up charge whose idempotency key (`cam_true_up:<lease>:<year>`)
  // collides with the OLD (already-posted) charge's key — the insert silently
  // no-ops on the 23505 conflict (that IS the OI-046 idempotency guarantee,
  // working exactly as designed), the status update still succeeds, and the
  // API reports success while the ledger keeps the STALE amount. Silent
  // under-billing, not an error anywhere in the call chain.
  //
  // REFUTE finding: a check-then-act pre-check (separate SELECT, then
  // upsert) closes the single-request-rerun case but not a genuine race — a
  // concurrent /:id/approve could bill the row in the window between the
  // check and the write. The fix instead makes the update itself atomically
  // conditional (`.neq('status','billed')`), the same "conditional update
  // IS the concurrency control" idiom OI-046 already uses on /:id/approve —
  // there is no window in which this can silently overwrite a billed row.
  // ---------------------------------------------------------------------------
  it('rejects recalculation of an already-billed reconciliation with 409, and the persisted row is untouched', async () => {
    state.rec = freshRec({
      lease_id: VALID_BODY.lease_id,
      reconciliation_year: VALID_BODY.reconciliation_year,
      status: 'billed',
      true_up_amount: 500,
    })

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(409)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/already been billed/i)
    // The stale $500 figure survives untouched — not silently overwritten
    // with the new (would-be $700-ish) recalculation.
    expect(state.rec?.status).toBe('billed')
    expect(state.rec?.true_up_amount).toBe(500)
  })

  it('still allows recalculation of a draft (not yet billed) reconciliation, via the atomic conditional update', async () => {
    state.rec = freshRec({
      lease_id: VALID_BODY.lease_id,
      reconciliation_year: VALID_BODY.reconciliation_year,
      status: 'draft',
    })

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(200)
    expect(camUpdateSpy).toHaveBeenCalledTimes(1)
    expect(camInsertSpy).not.toHaveBeenCalled() // update matched — never falls through to insert
    expect(state.rec?.status).toBe('draft')
  })

  // The race the REFUTE pass found: a concurrent approve bills the row
  // between when /calculate reads it (for the tenantSF/estimatedCamPaid
  // lookups) and when /calculate writes its recalculated figures. Modeled
  // here by flipping state.rec to 'billed' via the mock DIRECTLY (simulating
  // a concurrent request's completed write) before calculate()'s own
  // conditional update runs — the atomic `.neq('status','billed')` guard
  // must see the CURRENT (billed) state at write time, not a stale read.
  // (Guard is `.eq('status','draft')`, an allow-list — see the 'collected'
  // regression test below for why not `.neq('status','billed')`.)
  it('closes the TOCTOU race: a concurrent approve billing the row mid-request is not silently reopened', async () => {
    state.rec = freshRec({
      lease_id: VALID_BODY.lease_id,
      reconciliation_year: VALID_BODY.reconciliation_year,
      status: 'draft',
      true_up_amount: 500,
    })
    // Simulate the concurrent approve's write landing on the leases lookup
    // (the first DB call /calculate makes after validation) — by the time
    // /calculate reaches its own conditional update, the row is billed.
    const originalLeasesFrom = mockFrom.getMockImplementation()!
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leases' && state.rec?.status === 'draft') {
        Object.assign(state.rec as Row, { status: 'billed', true_up_amount: 500 })
      }
      return originalLeasesFrom(table)
    })

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(409)
    expect(state.rec?.status).toBe('billed')
    expect(state.rec?.true_up_amount).toBe(500) // never overwritten with the recalculated figure
  })

  // 'collected' is the third legal status (0002_financial_tables.sql:71),
  // currently unreachable elsewhere in this codebase but part of the DB's
  // own CHECK constraint. The guard is deliberately an allow-list
  // (`.eq('status','draft')`), not a deny-list against 'billed' — this
  // pins that choice: a deny-list would let this exact recalculation
  // silently succeed against a 'collected' row, reintroducing OI-069's bug
  // class for the third status value the moment anything starts setting it.
  it('also rejects recalculation of a "collected" reconciliation, not just "billed"', async () => {
    state.rec = freshRec({
      lease_id: VALID_BODY.lease_id,
      reconciliation_year: VALID_BODY.reconciliation_year,
      status: 'collected',
      true_up_amount: 500,
    })

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(409)
    expect(state.rec?.status).toBe('collected')
    expect(state.rec?.true_up_amount).toBe(500)
  })

  it('allows the first-ever calculation for a lease/year with no existing reconciliation', async () => {
    // Default state.rec (from beforeEach) has a DIFFERENT lease_id/year than
    // VALID_BODY, simulating "no existing row for this lease/year" — this is
    // the same fixture every other test in this describe block already
    // relies on implicitly; asserted explicitly here as an OI-069 regression
    // guard so a future change can't silently start blocking first-time
    // calculations.
    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(200)
    expect(camInsertSpy).toHaveBeenCalledTimes(1)
  })

  it('does not leak the raw Postgres error message if the already-billed existence check itself fails', async () => {
    state.rec = freshRec({
      lease_id: VALID_BODY.lease_id,
      reconciliation_year: VALID_BODY.reconciliation_year,
      status: 'billed',
    })
    state.recSelectError = { code: '57014', message: 'canceling statement due to statement timeout on relation "cam_reconciliations"' }

    const res = await calculate(VALID_BODY)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('statement timeout')
    expect(text).not.toContain('relation "cam_reconciliations"')
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


// ---------------------------------------------------------------------------
// Audit finding cam-ignores-rent-type-expense-stop (route): /calculate must load
// the lease's rent_type and expense_stop_amount and apply them.
// tenant 1,000 SF of 50,000 SF = 2% of $10,000 = $200 share.
// ---------------------------------------------------------------------------
describe('POST /api/cam/calculate: rent type and expense stop', () => {
  const BODY = {
    lease_id: '11111111-1111-1111-1111-111111111111',
    reconciliation_year: 2025,
    total_property_recoverable_expenses: 10000,
    total_leased_sf: 50000,
  }

  it('modified_gross WITHOUT an expense stop: 422, nothing saved', async () => {
    state.leaseRentType = 'modified_gross'
    state.leaseExpenseStop = null
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/expense stop/i)
    expect(camUpdateSpy).not.toHaveBeenCalled()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('modified_gross with a stop: only the share above the stop is owed', async () => {
    state.leaseRentType = 'modified_gross'
    state.leaseExpenseStop = 0.15 // $0.15/SF x 1,000 SF = $150 stop; $200 share -> $50 owed
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Row }
    expect(json.data.actual_cam_owed).toBe(50)
  })

  it('gross with no stop (full-service gross): owes nothing', async () => {
    state.leaseRentType = 'gross'
    state.leaseExpenseStop = null
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Row }
    expect(json.data.actual_cam_owed).toBe(0)
    expect(json.data.true_up_amount).toBe(0)
  })

  it('nnn: full pro-rata share (unchanged behaviour)', async () => {
    const res = await calculate(BODY)
    const json = await res.json() as { data: Row }
    expect(json.data.actual_cam_owed).toBe(200)
  })
})
