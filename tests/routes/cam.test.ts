import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable } from '../fixtures/pg-table'
import type * as CamLib from '../../server/lib/cam'

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
const mockRpc = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom, rpc: mockRpc }) }))

// REFUTE M6 (2026-11-10): calculateCAMTrueUp's plain-Error throws (share outside 0-1, negative SF)
// are guarded upstream and unreachable with valid mock data, so this flag forces one to prove the
// generic-error path in /calculate still invalidates the stale draft.
const faults = vi.hoisted(() => ({ trueUpThrowsPlainError: false }))
vi.mock('../../server/lib/cam', async (importOriginal) => {
  const actual = await importOriginal<typeof CamLib>()
  return {
    ...actual,
    calculateCAMTrueUp: (...args: Parameters<typeof actual.calculateCAMTrueUp>) => {
      if (faults.trueUpThrowsPlainError) throw new Error('tenant share must be a fraction between 0 and 1')
      return actual.calculateCAMTrueUp(...args)
    },
  }
})

type Row = Record<string, unknown>
type PgError = { code?: string; message: string }
type Predicate = { col: string; val: unknown; op: 'eq' | 'neq' }

function matchesAll(rec: Row | null, predicates: Predicate[]): boolean {
  if (!rec) return false
  return predicates.every((p) => (p.op === 'eq' ? rec[p.col] === p.val : rec[p.col] !== p.val))
}

const chargesInsertSpy = vi.fn()
const rpcSpy = vi.fn()
const camUpdateSpy = vi.fn()
const camInsertSpy = vi.fn()

const state = {
  rec: null as Row | null,
  recSelectError: null as PgError | null,
  leaseUnits: { sf: 1000 } as Row | null,
  leaseRentType: 'nnn' as string,
  leaseExpenseStop: null as number | null,
  // Server-side CAM pool (audit finding cam-denominator-client-snapshot). The default property has
  // the tenant's lease (1,000 SF via leaseUnits) plus one other full-year 49,000 SF lease, and one
  // $10,000 recoverable 2025 expense, so the server-computed figures reproduce the 2% / $200 share
  // the older tests in this file were written against (they used to send 50,000 / $10,000 in the
  // body; the server now ignores those).
  tenantLeaseStart: '2020-01-01',
  tenantLeaseEnd: '2030-12-31',
  tenantLeaseStatus: 'active',
  /** The tenant lease's unit_id; a value not in unitRows() models a lease with no unit/property. */
  tenantUnitId: 'u_tenant',
  extraUnits: [] as Row[],
  extraLeases: [] as Row[],
  // Building-RSF ruling (2026-11-08): the denominator is properties.cam_denominator_rsf, defaulted
  // to 50,000 so the default pool (tenant 1,000 SF) still reproduces the older tests' 2% / $200.
  denominatorRSF: 50000 as number | null,
  propertyError: null as PgError | null,
  leaseStatedPct: null as number | null,
  leaseBaseYear: null as number | null,
  leaseBaseAmount: null as number | null,
  omitOtherLease: false,
  expenses: [] as Row[],
  unitsError: null as PgError | null,
  expensesError: null as PgError | null,
  camEstimateCharges: [] as { amount: number; voided_at?: string | null }[],
  camChargesError: null as PgError | null,
  leaseSelectError: null as PgError | null,
  charges: [] as Row[],
  chargesInsertError: null as PgError | null,
  chargesSelectError: null as PgError | null,
  recReads: 0,
  afterRecRead: null as ((n: number) => void) | null,
  reconciliationUpdateError: null as PgError | null,
  /** Runs inside the approve RPC before its row lock: a concurrent write that committed first. */
  beforeRpc: null as (() => void) | null,
  rpcError: null as PgError | null,
  camInsertError: null as PgError | null,
  listReconciliations: [] as Row[],
  listError: null as PgError | null,
}

const PROPERTY_ID = '99999999-9999-4999-8999-999999999999'
const TENANT_LEASE_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_LEASE_ID = '22222222-2222-4222-8222-222222222222'

function unitRows(): Row[] {
  return [
    { id: 'u_tenant', property_id: PROPERTY_ID, sf: (state.leaseUnits as { sf: number } | null)?.sf ?? 0 },
    { id: 'u_other', property_id: PROPERTY_ID, sf: 49000 },
    ...state.extraUnits,
  ]
}

function leaseRows(): Row[] {
  const sfOf = (unitId: string) => unitRows().find((u) => u.id === unitId)
  const row = (r: Row): Row => ({
    proportionate_share_pct: null, base_year: null, base_year_expense_amount: null,
    ...r,
    units: { sf: sfOf(r.unit_id as string)?.sf, property_id: sfOf(r.unit_id as string)?.property_id },
  })
  return [
    row({
      id: TENANT_LEASE_ID, unit_id: state.tenantUnitId, status: state.tenantLeaseStatus,
      start_date: state.tenantLeaseStart, end_date: state.tenantLeaseEnd,
      rent_type: state.leaseRentType, expense_stop_amount: state.leaseExpenseStop,
      proportionate_share_pct: state.leaseStatedPct, base_year: state.leaseBaseYear,
      base_year_expense_amount: state.leaseBaseAmount,
    }),
    ...(state.omitOtherLease ? [] : [row({
      id: OTHER_LEASE_ID, unit_id: 'u_other', status: 'active',
      start_date: '2020-01-01', end_date: '2030-12-31', rent_type: 'nnn', expense_stop_amount: null,
    })]),
    ...state.extraLeases.map(row),
  ]
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
                // A COPY, like a real query result: approve's first read and its pre-post re-read
                // (REFUTE D1) must be able to differ. afterRecRead simulates a concurrent write
                // landing between the two reads.
                const snapshot = { ...(state.rec as Row) }
                state.recReads += 1
                state.afterRecRead?.(state.recReads)
                return { data: snapshot, error: null }
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
      return pgTable(leaseRows(), state.leaseSelectError ? { error: state.leaseSelectError } : {})
    }
    if (table === 'units') {
      return pgTable(unitRows(), state.unitsError ? { error: state.unitsError } : {})
    }
    if (table === 'properties') {
      return pgTable([{ id: PROPERTY_ID, cam_denominator_rsf: state.denominatorRSF }], state.propertyError ? { error: state.propertyError } : {})
    }
    if (table === 'expenses') {
      return pgTable(state.expenses, state.expensesError ? { error: state.expensesError } : {})
    }
    if (table === 'charges') {
      return {
        // /calculate's estimated-CAM-paid sum:
        //   .eq('lease_id').eq('type','cam_estimate').is('voided_at', null).gte(period_start).lte(period_end)
        // OI-278 / migration 0016: the `.is('voided_at', null)` link is applied for real — a voided
        // estimate row must not count as CAM already paid (it would understate the true-up).
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation((firstCol: string, firstVal: unknown) => firstCol === 'idempotency_key'
            // /:id/approve's already-posted check (REFUTE D1/D2 crash-recovery path).
            ? {
                limit: vi.fn().mockImplementation(async () => (
                  state.chargesSelectError
                    ? { data: null, error: state.chargesSelectError }
                    : { data: state.charges.filter((ch) => ch.idempotency_key === firstVal).map((ch) => ({ amount: ch.amount, voided_at: ch.voided_at ?? null, type: ch.type, lease_id: ch.lease_id })), error: null }
                )),
              }
            : {
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

  // approve_cam_reconciliation() (migration 0022), modelled on state.rec / state.charges with the same
  // contract the real function has (tests/db/cam-approve-atomic-0022.test.ts runs the real one on
  // PGlite). One synchronous body = one transaction: nothing interleaves inside it. state.beforeRpc
  // models a concurrent write that committed before the function took its row lock.
  mockRpc.mockImplementation(async (fn: string, args: Row) => {
    rpcSpy(fn, args)
    if (fn !== 'approve_cam_reconciliation') return { data: null, error: { message: `unknown rpc ${fn}` } }
    state.beforeRpc?.()
    if (state.rpcError) return { data: null, error: state.rpcError }
    const ok = (data: Row) => ({ data, error: null })
    const rec = state.rec
    if (!rec || rec.id !== args.p_id) return ok({ outcome: 'not_found' })
    if (rec.status !== 'draft') return ok({ outcome: 'not_draft', status: rec.status })
    if (rec.share_basis === null || rec.share_basis === undefined) return ok({ outcome: 'no_basis', status: rec.status })
    const c = (v: unknown) => Math.round(Number(v) * 100)
    if (c(rec.true_up_amount) !== c(args.p_true_up_amount) || rec.share_basis !== args.p_share_basis) {
      return ok({ outcome: 'changed', true_up_amount: rec.true_up_amount, share_basis: rec.share_basis })
    }
    const trueUp = Number(rec.true_up_amount)
    const key = `cam_true_up:${String(rec.lease_id)}:${String(rec.reconciliation_year)}`
    const holder = state.charges.find((ch) => ch.idempotency_key === key)
    if (holder) {
      if (holder.type !== 'cam_true_up' || holder.lease_id !== rec.lease_id) return ok({ outcome: 'foreign' })
      if (holder.voided_at) return ok({ outcome: 'voided' })
      if (!(trueUp > 0 && c(holder.amount) === c(trueUp))) {
        return ok({ outcome: 'live_mismatch', charge_amount: holder.amount, true_up_amount: rec.true_up_amount })
      }
      Object.assign(rec, { status: 'billed', billed_date: args.p_today })
      return ok({ outcome: 'billed', inserted: false, true_up_amount: rec.true_up_amount })
    }
    if (trueUp === 0) return ok({ outcome: 'balanced' })
    if (trueUp < 0) {
      Object.assign(rec, { status: 'billed', billed_date: args.p_today, notes: `Credit of ${Math.abs(trueUp).toFixed(2)} owed to tenant — handle manually (Phase 1 limitation)` })
      return ok({ outcome: 'billed_credit', true_up_amount: rec.true_up_amount })
    }
    const row = {
      lease_id: rec.lease_id, charge_date: args.p_today, due_date: args.p_today,
      period_start: `${String(rec.reconciliation_year)}-01-01`, period_end: `${String(rec.reconciliation_year)}-12-31`,
      type: 'cam_true_up', amount: trueUp, description: `${String(rec.reconciliation_year)} CAM True-Up`,
      source: 'manual', idempotency_key: key,
    }
    chargesInsertSpy(row)
    state.charges.push(row)
    Object.assign(rec, { status: 'billed', billed_date: args.p_today })
    return ok({ outcome: 'billed', inserted: true, true_up_amount: rec.true_up_amount })
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
    // 0021: drafts priced on the building-RSF basis carry a share_basis (a NULL one is pre-0021).
    share_basis: 'premises_rsf_over_denominator',
    // What /approve's recompute yields under APPROVE_FIXTURE: 2% of a $25,000 pool, nothing paid.
    total_property_recoverable_expenses: 25000,
    tenant_pro_rata_share_pct: 0.02,
    estimated_cam_paid: 0,
    actual_cam_owed: 500,
    recovery_basis: 'full_pro_rata',
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
  state.tenantLeaseStart = '2020-01-01'
  state.tenantLeaseEnd = '2030-12-31'
  state.tenantLeaseStatus = 'active'
  state.tenantUnitId = 'u_tenant'
  state.extraUnits = []
  state.extraLeases = []
  state.denominatorRSF = 50000
  state.propertyError = null
  state.leaseStatedPct = null
  state.leaseBaseYear = null
  state.leaseBaseAmount = null
  state.omitOtherLease = false
  state.expenses = [{ id: 'e_1', property_id: PROPERTY_ID, expense_date: '2025-06-01', amount: 10000, recoverable: true }]
  state.unitsError = null
  state.expensesError = null
  state.camEstimateCharges = []
  state.camChargesError = null
  state.leaseSelectError = null
  state.charges = []
  state.chargesInsertError = null
  state.chargesSelectError = null
  state.recReads = 0
  state.afterRecRead = null
  faults.trueUpThrowsPlainError = false
  state.reconciliationUpdateError = null
  state.beforeRpc = null
  state.rpcError = null
  state.camInsertError = null
  state.listReconciliations = []
  state.listError = null
  installDbMock()
})

// REFUTE H2 (2026-11-10): a refused /calculate prices nothing. No insert, and the ONLY update
// allowed is the invalidation patch that strips share_basis from an existing draft.
function expectRefusedNotPriced() {
  expect(camInsertSpy).not.toHaveBeenCalled()
  for (const [patch] of camUpdateSpy.mock.calls as [Row][]) {
    expect(Object.keys(patch).sort()).toEqual(['basis_warnings', 'share_basis'])
    expect(patch.share_basis).toBeNull()
  }
}

// ---------------------------------------------------------------------------
// POST /api/cam/:id/approve — atomic approval (OI-046)
// ---------------------------------------------------------------------------
// /approve recomputes before posting (REFUTE D1/D2): a $25,000 2025 pool makes the tenant's 2% share
// $500, so the default freshRec() draft is current.
// The default draft belongs to a dummy lease (so /calculate tests see "no existing row"); approve
// tests re-point it at TENANT_LEASE_ID, the lease the mocked DB can actually price.
function approveFixture() {
  state.expenses = [{ id: 'e_1', property_id: PROPERTY_ID, expense_date: '2025-06-01', amount: 25000, recoverable: true }]
  state.rec = freshRec({ lease_id: TENANT_LEASE_ID })
}

describe('POST /api/cam/:id/approve', () => {
  beforeEach(approveFixture)

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

  // RED 2 — an equal true-up that appears after this request's advisory check (a concurrent writer
  // of the same key) is not posted twice and not an error: the function finds it under its lock,
  // verifies it equals the draft (REFUTE F2) and completes the status.
  it('an equal true-up committed just before the approve function runs: billed, not posted twice', async () => {
    state.beforeRpc = () => {
      state.charges.push({ idempotency_key: `cam_true_up:${TENANT_LEASE_ID}:${YEAR}`, type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 500 })
    }

    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; true_up_amount: number }
    expect(body.success).toBe(true)
    expect(body.true_up_amount).toBe(500)
    expect(state.rec?.status).toBe('billed')
    expect(chargesInsertSpy).not.toHaveBeenCalled()
    expect(state.charges).toHaveLength(1)
  })

  it('calls approve_cam_reconciliation with the figures the recompute gate validated', async () => {
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(rpcSpy).toHaveBeenCalledTimes(1)
    expect(rpcSpy).toHaveBeenCalledWith('approve_cam_reconciliation', {
      p_id: REC_ID, p_true_up_amount: 500, p_share_basis: 'premises_rsf_over_denominator',
      p_today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
  })

  it('a reconciliation deleted between the read and the function: 404, nothing posted', async () => {
    state.beforeRpc = () => { state.rec = null }
    const res = await approve(REC_ID)
    expect(res.status).toBe(404)
    expect(state.charges).toHaveLength(0)
  })

  it('an unknown outcome from the function is a 500, never reported as success', async () => {
    mockRpc.mockImplementationOnce(async () => ({ data: { outcome: 'something_new' }, error: null }))
    const res = await approve(REC_ID)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('something_new')
  })

  // RED 3 — the true-up insert payload carries the documented idempotency key.
  it('posts the true-up charge with idempotency_key cam_true_up:<lease_id>:<year>', async () => {
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(chargesInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: `cam_true_up:${TENANT_LEASE_ID}:${YEAR}` })
    )
  })

  it('applies the same conditional-update guard to the negative (credit) branch — no double-billing race', async () => {
    // $575 of estimates paid against $500 owed: a $75 credit that matches the live recompute.
    state.camEstimateCharges = [{ amount: 575 }]
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, true_up_amount: -75, estimated_cam_paid: 575 })

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

  // RED 5 (approve variant) — a genuine DB error inside the approve function (it rolled back) must
  // never leak the raw Postgres message, and never read as success.
  it('does not leak the raw Postgres error message when the approve function genuinely fails', async () => {
    state.rpcError = { code: '23503', message: 'insert or update on table "cam_reconciliations" violates foreign key constraint "cam_reconciliations_lease_id_fkey"' }

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
    expectRefusedNotPriced()
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


// ---------------------------------------------------------------------------
// Audit finding cam-denominator-client-snapshot: the denominator (and the
// recoverable total) are recomputed server-side from the DB; client values are
// ignored. Denominator = occupancy-weighted leased SF over the year, including
// leases that ended or started mid-year, excluding 'pending' leases.
// Default pool: tenant 1,000 SF + other 49,000 SF, both full-year; $10,000.
// ---------------------------------------------------------------------------
describe('POST /api/cam/calculate: server-side pool (denominator + recoverable total)', () => {
  const BODY = { lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 }
  type Saved = { data: Row }

  it('accepts a body WITHOUT client totals and computes them from the DB', async () => {
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as Saved
    expect(json.data.tenant_pro_rata_share_pct).toBeCloseTo(0.02, 12)
    expect(json.data.total_property_recoverable_expenses).toBe(10000)
    expect(json.data.actual_cam_owed).toBe(200)
  })

  it('IGNORES a client-supplied denominator and recoverable total (a stale or tampered browser value)', async () => {
    const res = await calculate({ ...BODY, total_leased_sf: 1000, total_property_recoverable_expenses: 999999 })
    expect(res.status).toBe(200)
    const json = await res.json() as Saved
    expect(json.data.tenant_pro_rata_share_pct).toBeCloseTo(0.02, 12)
    expect(json.data.total_property_recoverable_expenses).toBe(10000)
    expect(json.data.actual_cam_owed).toBe(200)
  })

  it('a lease that EXPIRED mid-year does not change another tenant\'s share (building RSF denominator)', async () => {
    // Ruling 2026-11-08: the denominator is the building RSF, so a move-out leaves the remaining
    // tenants' shares unchanged (the landlord carries the vacancy). RSF must still cover the Q1 peak
    // of 1,000 + 49,000 + 36,500 = 86,500 leased SF.
    state.denominatorRSF = 86500
    state.extraUnits = [{ id: 'u_gone', property_id: PROPERTY_ID, sf: 36500 }]
    state.extraLeases = [{ id: '33333333-3333-4333-8333-333333333333', unit_id: 'u_gone', status: 'expired', start_date: '2019-01-01', end_date: '2025-03-31', rent_type: 'nnn', expense_stop_amount: null }]
    const json = await (await calculate(BODY)).json() as Saved
    expect(json.data.tenant_pro_rata_share_pct).toBeCloseTo(1000 / 86500, 12)
  })

  it('excludes pending leases and leases that did not overlap the year', async () => {
    state.extraUnits = [{ id: 'u_x', property_id: PROPERTY_ID, sf: 50000 }, { id: 'u_y', property_id: PROPERTY_ID, sf: 50000 }]
    state.extraLeases = [
      { id: '44444444-4444-4444-8444-444444444444', unit_id: 'u_x', status: 'pending', start_date: '2025-01-01', end_date: '2030-12-31', rent_type: 'nnn', expense_stop_amount: null },
      { id: '55555555-5555-4555-8555-555555555555', unit_id: 'u_y', status: 'expired', start_date: '2018-01-01', end_date: '2024-12-31', rent_type: 'nnn', expense_stop_amount: null },
    ]
    const json = await (await calculate(BODY)).json() as Saved
    expect(json.data.tenant_pro_rata_share_pct).toBeCloseTo(0.02, 12)
  })

  it('a tenant that moved in mid-year bears its share for its own days in effect only', async () => {
    state.tenantLeaseStart = '2025-07-01' // 184 days
    const json = await (await calculate(BODY)).json() as Saved
    expect(json.data.tenant_pro_rata_share_pct).toBeCloseTo((1000 / 50000) * 184 / 365, 12)
  })

  it('a lease not in effect at any point in the year: 422, nothing saved', async () => {
    state.tenantLeaseStart = '2026-01-01'
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expectRefusedNotPriced()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('only counts expenses for THIS property, recoverable, inside the year', async () => {
    state.expenses = [
      { id: 'e_1', property_id: PROPERTY_ID, expense_date: '2025-01-01', amount: 4000, recoverable: true },
      { id: 'e_2', property_id: PROPERTY_ID, expense_date: '2025-12-31', amount: 6000, recoverable: true },
      { id: 'e_3', property_id: PROPERTY_ID, expense_date: '2024-12-31', amount: 99999, recoverable: true },
      { id: 'e_4', property_id: PROPERTY_ID, expense_date: '2025-05-01', amount: 99999, recoverable: false },
      { id: 'e_5', property_id: 'other-prop', expense_date: '2025-05-01', amount: 99999, recoverable: true },
    ]
    const json = await (await calculate(BODY)).json() as Saved
    expect(json.data.total_property_recoverable_expenses).toBe(10000)
  })

  it('fails closed (500, nothing saved) when the units read fails', async () => {
    state.unitsError = { message: 'boom units' }
    const res = await calculate(BODY)
    expect(res.status).toBe(500)
    expect(camInsertSpy).not.toHaveBeenCalled()
    expect(await res.text()).not.toContain('boom units')
  })

  it('fails closed (500, nothing saved) when the expenses read fails', async () => {
    state.expensesError = { message: 'boom expenses' }
    const res = await calculate(BODY)
    expect(res.status).toBe(500)
    expect(camInsertSpy).not.toHaveBeenCalled()
  })
})

describe('GET /api/cam/pool', () => {
  const pool = (qs: string) => app.request(`/api/cam/pool?${qs}`, {}, env)
  type PoolBody = { data: { recoverable_total: number; weighted_leased_sf: number; days_in_year: number; leases: { lease_id: string; weighted_sf: number; overlap_days: number; status: string; rent_type: string }[] } }

  it('returns the server-computed pool for a property/year', async () => {
    const res = await pool(`property_id=${PROPERTY_ID}&year=2025`)
    expect(res.status).toBe(200)
    const body = await res.json() as PoolBody
    expect(body.data.recoverable_total).toBe(10000)
    expect(body.data.weighted_leased_sf).toBe(50000)
    expect(body.data.days_in_year).toBe(365)
    expect(body.data.leases.map((l) => l.lease_id).sort()).toEqual([TENANT_LEASE_ID, OTHER_LEASE_ID].sort())
  })

  it('400 on a malformed property_id', async () => {
    expect((await pool('property_id=nope&year=2025')).status).toBe(400)
  })
})

describe('POST /api/cam/calculate: same-unit overlap (REFUTE C4b)', () => {
  it('422 naming the unit and leases when a terminated lease and its replacement overlap on one unit; nothing saved', async () => {
    state.extraLeases = [{
      id: '66666666-6666-4666-8666-666666666666', unit_id: 'u_other', status: 'terminated',
      start_date: '2019-01-01', end_date: '2028-12-31', rent_type: 'nnn', expense_stop_amount: null,
    }]
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(422)
    const { error } = await res.json() as { error: string }
    expect(error).toMatch(/u_other/)
    expect(error).toMatch(/66666666-6666-4666-8666-666666666666/)
    expect(error).toMatch(new RegExp(OTHER_LEASE_ID))
    expectRefusedNotPriced()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/cam/calculate: implausible expense stop (REFUTE C4d)', () => {
  it('422 and nothing saved when stop x SF exceeds the share by more than 1x', async () => {
    state.leaseRentType = 'modified_gross'
    state.leaseExpenseStop = 42000 // a total typed into the $/SF/yr field; share is $200
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/\$\/SF\/yr/)
    expect(camInsertSpy).not.toHaveBeenCalled()
  })
})

describe("POST /api/cam/calculate: stale terminated lease on a vacant unit (REFUTE C4b')", () => {
  it('422 telling the user to correct the end_date; nothing saved', async () => {
    state.extraUnits = [{ id: 'u_vacant', property_id: PROPERTY_ID, sf: 10000 }]
    state.extraLeases = [{
      id: '77777777-7777-4777-8777-777777777777', unit_id: 'u_vacant', status: 'terminated',
      start_date: '2019-01-01', end_date: '2099-12-31', rent_type: 'nnn', expense_stop_amount: null,
    }]
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(422)
    const { error } = await res.json() as { error: string }
    expect(error).toMatch(/77777777-7777-4777-8777-777777777777/)
    expect(error).toMatch(/correct.*end_date/i)
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('a terminated lease whose end_date is already past is fine (weighted by its days in effect)', async () => {
    state.denominatorRSF = 86500 // the building RSF must cover the Q1 peak (1,000 + 49,000 + 36,500)
    state.extraUnits = [{ id: 'u_gone', property_id: PROPERTY_ID, sf: 36500 }]
    state.extraLeases = [{
      id: '88888888-8888-4888-8888-888888888888', unit_id: 'u_gone', status: 'terminated',
      start_date: '2019-01-01', end_date: '2025-03-31', rent_type: 'nnn', expense_stop_amount: null,
    }]
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Gabriel ruling 2026-11-08: Proportionate Share on BUILDING (or project) RENTABLE SF.
// Default pool: tenant 1,000 SF, other tenant 49,000 SF, property cam_denominator_rsf 50,000,
// $10,000 recoverable in 2025.
// ---------------------------------------------------------------------------
describe('POST /api/cam/calculate: building RSF denominator (ruling 2026-11-08)', () => {
  const BODY = { lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 }
  type Saved = { data: Row; warnings: string[] }

  it('the landlord carries vacancy: with the other tenant gone the share stays 1,000 / 50,000', async () => {
    state.omitOtherLease = true
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as Saved
    expect(json.data.tenant_pro_rata_share_pct).toBeCloseTo(0.02, 12)
    expect(json.data.actual_cam_owed).toBe(200) // not $10,000 (the old leased-SF basis billed 100%)
  })

  it('persists the basis on the draft (premises RSF / denominator; full pro-rata)', async () => {
    const json = await (await calculate(BODY)).json() as Saved
    expect(json.data.share_basis).toBe('premises_rsf_over_denominator')
    expect(json.data.recovery_basis).toBe('full_pro_rata')
    expect(json.data.basis_warnings).toBeNull()
    expect(json.warnings).toEqual([])
  })

  it('a lease-stated % overrides the computed share', async () => {
    state.leaseStatedPct = 0.024 // 0.4 pp from 2%: no warning
    const json = await (await calculate(BODY)).json() as Saved
    expect(json.data.tenant_pro_rata_share_pct).toBeCloseTo(0.024, 12)
    expect(json.data.actual_cam_owed).toBe(240)
    expect(json.data.share_basis).toBe('lease_stated_pct')
    expect(json.warnings).toEqual([])
  })

  it('stated vs computed more than 0.5 pp apart: 200 with a warning (persisted), never a 422', async () => {
    state.omitOtherLease = true // isolate the mismatch warning from the >100% pool warning
    state.leaseStatedPct = 0.03
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as Saved
    expect(json.data.actual_cam_owed).toBe(300)
    expect(json.warnings).toHaveLength(1)
    expect(json.warnings[0]).toMatch(/3\.00%.*2\.00%/)
    expect(json.data.basis_warnings).toBe(json.warnings[0])
  })

  it('a stated % works without any property RSF', async () => {
    state.denominatorRSF = null
    state.leaseStatedPct = 0.02
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Saved).data.actual_cam_owed).toBe(200)
  })

  it('neither a stated % nor a property RSF: 422, nothing saved', async () => {
    state.denominatorRSF = null
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/rentable SF/i)
    expectRefusedNotPriced()
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('property RSF smaller than the SF leased in the pool: 422, nothing saved (even with a stated %)', async () => {
    state.denominatorRSF = 40000 // 50,000 SF leased all year
    state.leaseStatedPct = 0.02
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/40,000.*50,000/)
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('fails closed (500, nothing saved, no raw text) when the property read fails', async () => {
    state.propertyError = { message: 'boom property' }
    const res = await calculate(BODY)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('boom property')
    expect(camInsertSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/cam/calculate: base year (ruling 2026-11-08)', () => {
  const BODY = { lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 }
  type Saved = { data: Row }

  it('owes share x (current recoverable - base-year amount)', async () => {
    state.leaseRentType = 'modified_gross'
    state.leaseBaseYear = 2023
    state.leaseBaseAmount = 8000
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as Saved
    expect(json.data.actual_cam_owed).toBe(40) // 2% x ($10,000 - $8,000)
    expect(json.data.recovery_basis).toBe('above_base_year')
  })

  it('a base year with no base amount: 422, nothing saved', async () => {
    state.leaseBaseYear = 2023
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/base-year expense amount/)
    expect(camInsertSpy).not.toHaveBeenCalled()
  })

  it('nnn with no base year: full share, unchanged', async () => {
    const json = await (await calculate(BODY)).json() as Saved
    expect(json.data.actual_cam_owed).toBe(200)
  })
})

describe('GET /api/cam/pool: share basis per lease', () => {
  const pool = (qs: string) => app.request(`/api/cam/pool?${qs}`, {}, env)
  type PoolLease = { lease_id: string; share_basis: string | null; annual_share_pct: number | null; effective_share_pct: number | null; stated_share_pct: number | null; computed_share_pct: number | null; share_error: string | null; warnings: string[] }
  type PoolBody = { data: { denominator_rsf: number | null; peak_leased_sf: number; leases: PoolLease[] } }

  it('returns the denominator, peak leased SF and each lease\'s basis and shares', async () => {
    state.leaseStatedPct = 0.03
    const res = await pool(`property_id=${PROPERTY_ID}&year=2025`)
    expect(res.status).toBe(200)
    const body = await res.json() as PoolBody
    expect(body.data.denominator_rsf).toBe(50000)
    expect(body.data.peak_leased_sf).toBe(50000)
    const t = body.data.leases.find((l) => l.lease_id === TENANT_LEASE_ID) as PoolLease
    expect(t.share_basis).toBe('lease_stated_pct')
    expect(t.annual_share_pct).toBeCloseTo(0.03, 12)
    expect(t.computed_share_pct).toBeCloseTo(0.02, 12)
    expect(t.warnings).toHaveLength(1)
    const o = body.data.leases.find((l) => l.lease_id === OTHER_LEASE_ID) as PoolLease
    expect(o.share_basis).toBe('premises_rsf_over_denominator')
    expect(o.annual_share_pct).toBeCloseTo(0.98, 12)
  })

  it('a lease with no basis is reported per lease (share_error), not a whole-pool 422', async () => {
    state.denominatorRSF = null
    state.leaseStatedPct = 0.02
    const res = await pool(`property_id=${PROPERTY_ID}&year=2025`)
    expect(res.status).toBe(200)
    const body = await res.json() as PoolBody
    const o = body.data.leases.find((l) => l.lease_id === OTHER_LEASE_ID) as PoolLease
    expect(o.share_basis).toBeNull()
    expect(o.share_error).toMatch(/rentable SF/i)
  })

  it('RSF smaller than the peak leased SF: 422', async () => {
    state.denominatorRSF = 10000
    expect((await pool(`property_id=${PROPERTY_ID}&year=2025`)).status).toBe(422)
  })
})

describe('POST /api/cam/:id/approve: pre-0021 drafts (leased-SF basis) are not billable', () => {
  it('409 and nothing posted for a draft with no share_basis; the row stays a draft', async () => {
    state.rec = freshRec({ share_basis: null })
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/recalculate/i)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
    expect((state.rec as Row).status).toBe('draft')
  })

  it('a recalculated draft (share_basis set) still approves normally', async () => {
    approveFixture()
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(chargesInsertSpy).toHaveBeenCalledTimes(1)
  })
})

describe('over-recovery warning: concurrent stated shares above 100%', () => {
  it('/calculate returns 200 with a pool warning when stated shares total more than 100%', async () => {
    state.leaseStatedPct = 0.05 // other lease computes to 98% -> 103% concurrently
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Row; warnings: string[] }
    expect(json.warnings.some((w) => /103\.00%/.test(w))).toBe(true)
    expect(String(json.data.basis_warnings)).toMatch(/103\.00%/)
  })
})

// ---------------------------------------------------------------------------
// REFUTE round E (Opus adversarial-reviewer, 2026-11-10) regressions.
// ---------------------------------------------------------------------------
describe('holdover: excluded from CAM and flagged (ruling 2026-11-08; REFUTE C4)', () => {
  const pool = (qs: string) => app.request(`/api/cam/pool?${qs}`, {}, env)
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  it('an active lease whose term ended mid-year: billed only to end_date, and the draft carries the holdover flag', async () => {
    state.tenantLeaseEnd = '2025-06-30' // status stays 'active': the tenant is holding over
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Row; warnings: string[] }
    // 2% x $10,000 x 181/365 days: the holdover half-year is excluded, not billed.
    expect(json.data.actual_cam_owed).toBeCloseTo((200 * 181) / 365, 2)
    const flag = json.warnings.find((w) => /^Holdover:/.test(w))
    expect(flag).toMatch(new RegExp(`${TENANT_LEASE_ID}.*2025-06-30`))
    expect(String(json.data.basis_warnings)).toContain(flag as string)
  })

  it('a holdover lease that ended before the year is flagged on /pool and refused by name on /calculate', async () => {
    state.tenantLeaseEnd = '2024-06-30'
    const p = await pool(`property_id=${PROPERTY_ID}&year=2025`)
    expect(p.status).toBe(200)
    const pj = await p.json() as { data: { warnings: string[]; leases: Row[] } }
    expect(pj.data.leases.map((l) => l.lease_id)).not.toContain(TENANT_LEASE_ID)
    expect(pj.data.warnings.some((w) => w.startsWith('Holdover:') && w.includes(TENANT_LEASE_ID))).toBe(true)

    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/^Holdover:/)
  })

  it('not holdover: an expired lease, a lease ending on the last day of the year, a term not yet over', async () => {
    // '2026-12-01' in 2026: still in term on 2026-11-10, so the cutoff must be today, not the year
    // end (round-2 mutation M4 survived without this case).
    for (const [status, end, year] of [['expired', '2025-06-30', 2025], ['active', '2025-12-31', 2025], ['active', '2026-12-31', 2026], ['active', '2026-12-01', 2026]] as const) {
      state.tenantLeaseStatus = status
      state.tenantLeaseEnd = end
      installDbMock()
      const p = await pool(`property_id=${PROPERTY_ID}&year=${year}`)
      expect(p.status).toBe(200)
      const pj = await p.json() as { data: { warnings: string[] } }
      expect(pj.data.warnings.filter((w) => w.startsWith('Holdover:'))).toEqual([])
    }
  })

  it('the current year flags an active lease whose end_date has already passed this year', async () => {
    state.tenantLeaseEnd = '2026-03-31'
    const p = await pool(`property_id=${PROPERTY_ID}&year=2026`)
    const pj = await p.json() as { data: { warnings: string[] } }
    expect(pj.data.warnings.some((w) => w.startsWith('Holdover:') && w.includes('2026-03-31'))).toBe(true)
  })
})

describe('denominator below the property\'s summed unit SF (REFUTE H1)', () => {
  it('warns on a computed share (saved with the draft) and on /pool, but does not refuse', async () => {
    state.extraUnits = [{ id: 'u_vacant', property_id: PROPERTY_ID, sf: 20000 }] // 70,000 SF of units vs 50,000 RSF
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Row; warnings: string[] }
    expect(json.data.actual_cam_owed).toBe(200)
    expect(json.warnings.some((w) => /50,000 RSF.*70,000 SF of units/.test(w))).toBe(true)
    expect(String(json.data.basis_warnings)).toMatch(/70,000 SF of units/)

    const p = await app.request(`/api/cam/pool?property_id=${PROPERTY_ID}&year=2025`, {}, env)
    const pj = await p.json() as { data: { warnings: string[] } }
    expect(pj.data.warnings.some((w) => /70,000 SF of units/.test(w))).toBe(true)
  })

  it('a stated share ignores the RSF, so its draft does not carry the denominator warning', async () => {
    state.extraUnits = [{ id: 'u_vacant', property_id: PROPERTY_ID, sf: 20000 }]
    state.omitOtherLease = true // keep the >100% pool warning out of this assertion
    state.leaseStatedPct = 0.02
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    expect(res.status).toBe(200)
    const json = await res.json() as { warnings: string[] }
    expect(json.warnings.filter((w) => /SF of units/.test(w))).toEqual([])
  })

  it('no warning when the denominator covers every unit', async () => {
    const res = await calculate({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 })
    const json = await res.json() as { warnings: string[] }
    expect(json.warnings.filter((w) => /SF of units/.test(w))).toEqual([])
  })
})

describe('a refused recalculation invalidates the previous draft (REFUTE H2)', () => {
  const BODY = { lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 }
  const priorDraft = () => freshRec({ lease_id: TENANT_LEASE_ID, reconciliation_year: 2025, true_up_amount: 500 })

  it('lease changed to a base year with no amount: 422, the old full-NNN draft loses its basis, and approve refuses it', async () => {
    state.rec = priorDraft()
    state.leaseBaseYear = 2024
    state.leaseBaseAmount = null
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expectRefusedNotPriced()
    expect(state.rec?.share_basis).toBeNull()
    expect(String(state.rec?.basis_warnings)).toMatch(/^Last recalculation was refused: /)
    expect(state.rec?.true_up_amount).toBe(500) // amounts untouched; the row is simply not billable

    const ap = await approve(REC_ID)
    expect(ap.status).toBe(409)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
    expect(state.rec?.status).toBe('draft')
  })

  it('property RSF corrected below the leased SF: the old draft is invalidated too', async () => {
    state.rec = priorDraft()
    state.denominatorRSF = 40000
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(state.rec?.share_basis).toBeNull()
  })

  it('a lease with no unit/property: 422 and the old draft is invalidated (round-2 mutation M7)', async () => {
    state.rec = priorDraft()
    state.tenantUnitId = 'u_missing'
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/no unit\/property/)
    expectRefusedNotPriced()
    expect(state.rec?.share_basis).toBeNull()
  })

  it('a billed reconciliation is never touched by the invalidation', async () => {
    state.rec = priorDraft()
    state.rec.status = 'billed'
    state.denominatorRSF = null
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(state.rec?.share_basis).toBe('premises_rsf_over_denominator')
    expect(state.rec?.status).toBe('billed')
  })

  it('fails closed (500) when the invalidation write itself fails, instead of a 422 that leaves the draft billable', async () => {
    state.rec = priorDraft()
    state.denominatorRSF = null
    state.reconciliationUpdateError = { message: 'boom update' }
    const res = await calculate(BODY)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('boom update')
  })
})

// ---------------------------------------------------------------------------
// REFUTE follow-ups (2026-11-10): D1 approve race, D2 stale drafts, L1 string amounts, L3 base year,
// M6 generic-error invalidation.
// ---------------------------------------------------------------------------
describe('POST /api/cam/:id/approve recomputes before posting (REFUTE D1/D2)', () => {
  beforeEach(approveFixture)

  it('an expense posted after the draft was calculated: 409 stale, nothing posted, row stays a draft', async () => {
    state.expenses.push({ id: 'e_2', property_id: PROPERTY_ID, expense_date: '2025-11-01', amount: 5000, recoverable: true })
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/stale.*true_up_amount 500 -> 600/)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
    expect(state.rec?.status).toBe('draft')
  })

  it('a lease edited to a base year with no amount after the draft: 409 (recalculation now refused), nothing posted', async () => {
    state.leaseBaseYear = 2024
    state.leaseBaseAmount = null
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/stale: recalculating it now is refused/)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
  })

  it('the property RSF corrected after the draft: 409 on the changed share, nothing posted', async () => {
    state.denominatorRSF = 100000 // 1,000 / 100,000 = 1%, not the draft's 2%
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
  })

  it('a concurrent write between the recompute and the post (D1): 409, nothing posted', async () => {
    // Read 1 = approve's initial read. A refused recalculation lands after it, during the recompute,
    // and strips share_basis (REFUTE H2's invalidation); the function sees it under its lock.
    state.afterRecRead = (n) => { if (n === 1) (state.rec as Row).share_basis = null }
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/no valid Proportionate Share basis/)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
    expect(state.rec?.status).toBe('draft')
  })

  it('crash recovery: the true-up is already posted, so the data drift is not re-checked and the status completes', async () => {
    state.charges = [{ idempotency_key: `cam_true_up:${TENANT_LEASE_ID}:${YEAR}`, type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 500 }]
    state.expenses.push({ id: 'e_2', property_id: PROPERTY_ID, expense_date: '2025-11-01', amount: 5000, recoverable: true })
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(state.rec?.status).toBe('billed')
    expect(state.charges.filter((ch) => ch.type === 'cam_true_up')).toHaveLength(1)
  })

  it('fails closed (500, nothing posted) when the already-posted check errors', async () => {
    state.chargesSelectError = { message: 'boom charges select' }
    const res = await approve(REC_ID)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('boom charges select')
    expect(chargesInsertSpy).not.toHaveBeenCalled()
  })

  it('a current draft still approves (control)', async () => {
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(state.charges.filter((ch) => ch.type === 'cam_true_up')).toEqual([expect.objectContaining({ amount: 500 })])
  })
})

describe('POST /api/cam/calculate: type and error-path hardening (REFUTE L1, L3, M6)', () => {
  const BODY = { lease_id: TENANT_LEASE_ID, reconciliation_year: 2025 }

  it('L1: CAM estimate amounts arriving as NUMERIC strings are summed as money, not concatenated', async () => {
    state.camEstimateCharges = [{ amount: '60.10' as unknown as number }, { amount: '39.90' as unknown as number }]
    const res = await calculate(BODY)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Row }
    expect(json.data.estimated_cam_paid).toBe(100)
    expect(json.data.true_up_amount).toBe(100) // $200 owed - $100 paid
  })

  it('L3: a base year that is not an integer year is refused (422), not billed as already passed', async () => {
    state.leaseBaseYear = 'abc' as unknown as number
    state.leaseBaseAmount = 9000
    const res = await calculate(BODY)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/not a calendar year/)
    expectRefusedNotPriced()
  })

  it('M6: a plain Error from the true-up math is a 400 that still invalidates the existing draft', async () => {
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID })
    faults.trueUpThrowsPlainError = true
    const res = await calculate(BODY)
    expect(res.status).toBe(400)
    expectRefusedNotPriced()
    expect(state.rec?.share_basis).toBeNull()
  })
})

describe('approve gate, REFUTE round 2 (2026-11-10): isolated drift, billed rows, compare-and-swap', () => {
  beforeEach(approveFixture)

  it('D3: a share-only change (true-up unchanged) is still refused', async () => {
    // Empty pool: owed is $0 whatever the share, so the true-up stays -$100 while the share moves.
    state.expenses = []
    state.camEstimateCharges = [{ amount: 100 }]
    state.rec = freshRec({
      lease_id: TENANT_LEASE_ID, total_property_recoverable_expenses: 0, estimated_cam_paid: 100,
      actual_cam_owed: 0, true_up_amount: -100,
    })
    state.denominatorRSF = 100000 // 2% -> 1%
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/tenant_pro_rata_share_pct 0\.02 -> 0\.01/)
    expect(state.rec?.status).toBe('draft')
  })

  it('D3: owed and paid moving together (true-up unchanged) is still refused', async () => {
    state.expenses.push({ id: 'e_2', property_id: PROPERTY_ID, expense_date: '2025-11-01', amount: 5000, recoverable: true })
    state.camEstimateCharges = [{ amount: 100 }] // +$100 owed, +$100 paid: true-up still $500
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/actual_cam_owed 500 -> 600/)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
  })

  it('D2: a billed row posts nothing, even after its charge was deleted', async () => {
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, status: 'billed' })
    state.charges = [] // the true-up charge was deleted via DELETE /charges/:id
    const res = await approve(REC_ID)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('already billed')
    expect(chargesInsertSpy).not.toHaveBeenCalled()
  })

  it('D1: a recalculation landing after the recompute gate is refused by the function, and NOTHING is posted', async () => {
    // Before 0022 this posted the 500 charge and then 409'd on the status compare-and-swap.
    state.beforeRpc = () => { (state.rec as Row).true_up_amount = 600 }
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/changed while it was being approved \(true_up_amount 500 -> 600\).*NOT marked billed.*No charge was posted/)
    expect(state.rec?.status).toBe('draft')
    expect(state.charges).toHaveLength(0)
  })

  it('D1 (credit): the same check guards the credit branch; nothing was posted', async () => {
    state.camEstimateCharges = [{ amount: 575 }]
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, true_up_amount: -75, estimated_cam_paid: 575 })
    state.beforeRpc = () => { (state.rec as Row).true_up_amount = -80 }
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/No charge was posted/)
    expect(state.rec?.status).toBe('draft')
  })

  it('D1 (basis): a share_basis change after the gate is refused as changed', async () => {
    state.beforeRpc = () => { (state.rec as Row).share_basis = 'lease_stated_pct' }
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/share_basis premises_rsf_over_denominator -> lease_stated_pct/)
    expect(state.charges).toHaveLength(0)
  })
})

describe('approve with a true-up already on the ledger (REFUTE F2, 2026-11-10)', () => {
  beforeEach(approveFixture)
  const KEY = () => `cam_true_up:${TENANT_LEASE_ID}:${YEAR}`

  it('crash, then a recalculation to a DIFFERENT figure: 409 naming both, not billed, no second charge', async () => {
    state.charges = [{ idempotency_key: KEY(), type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 500 }]
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, true_up_amount: 600, actual_cam_owed: 600, total_property_recoverable_expenses: 30000 })
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/charge of 500\.00 is already posted.*now says 600\.00.*NOT marked billed/)
    expect(state.rec?.status).toBe('draft')
    expect(state.charges).toHaveLength(1)
  })

  it('a +500 charge is live and the draft became a credit: 409, never billed as "credit, not auto-posted"', async () => {
    state.charges = [{ idempotency_key: KEY(), type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 500 }]
    state.camEstimateCharges = [{ amount: 575 }]
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, true_up_amount: -75, estimated_cam_paid: 575 })
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/500\.00 is already posted.*-75\.00 \(a credit\)/)
    expect(state.rec?.status).toBe('draft')
  })

  it('the 409 -> approve-again path from the old D1 fix no longer bills a mismatch', async () => {
    // First approve: a recalculation after the gate -> 409. With 0022 nothing is posted at all.
    state.beforeRpc = () => { (state.rec as Row).true_up_amount = 600 }
    expect((await approve(REC_ID)).status).toBe(409)
    state.beforeRpc = null
    expect(state.charges).toHaveLength(0)
    // Second approve on the 600 row (whose other figures still say 500): the recompute gate refuses it.
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(state.rec?.status).toBe('draft')
    expect(state.charges).toHaveLength(0)
  })

  it('a concurrent writer posted a DIFFERENT amount just before the function ran: 409, not billed', async () => {
    state.beforeRpc = () => {
      state.charges.push({ idempotency_key: KEY(), type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 450 })
    }
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/charge of 450\.00 is already posted.*now says 500\.00.*NOT marked billed/)
    expect(state.rec?.status).toBe('draft')
    expect(state.charges).toEqual([expect.objectContaining({ amount: 450 })])
  })

  it('a voided true-up still holding the key: 409, nothing posted, not billed', async () => {
    state.charges = [{ idempotency_key: KEY(), type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 500, voided_at: '2026-11-01T00:00:00Z' }]
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/voided/)
    expect(chargesInsertSpy).not.toHaveBeenCalled()
    expect(state.rec?.status).toBe('draft')
  })

  it('crash recovery still completes when the posted charge equals the draft to the cent (string NUMERIC)', async () => {
    state.charges = [{ idempotency_key: KEY(), type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: '500.00' }]
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(state.rec?.status).toBe('billed')
    expect(state.charges).toHaveLength(1)
  })
})

describe('approve, REFUTE F3 (2026-11-10): balanced drafts, foreign key holders, the credit race', () => {
  beforeEach(approveFixture)
  const KEY = () => `cam_true_up:${TENANT_LEASE_ID}:${YEAR}`

  it('a balanced draft with a live true-up charge on the ledger: 409 naming it, not "no true-up required"', async () => {
    state.charges = [{ idempotency_key: KEY(), type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 500 }]
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, true_up_amount: 0 })
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/now balanced.*500\.00 is posted.*Delete/)
  })

  it('a balanced draft with nothing posted is still "no true-up required" (control)', async () => {
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, true_up_amount: 0 })
    const res = await approve(REC_ID)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { message: string }).message).toMatch(/No true-up required/)
  })

  it('a charge of another type (or lease) holding the true-up key is not accepted as the posted true-up', async () => {
    state.charges = [{ idempotency_key: KEY(), type: 'other', lease_id: TENANT_LEASE_ID, amount: 500 }]
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/Another charge already uses/)
    expect(state.rec?.status).toBe('draft')
  })

  it('THE LOUD PATH: a +true-up posted by a concurrent approval before this credit is billed -> never billed, 409', async () => {
    state.camEstimateCharges = [{ amount: 575 }]
    state.rec = freshRec({ lease_id: TENANT_LEASE_ID, true_up_amount: -75, estimated_cam_paid: 575 })
    // A concurrent approval of the earlier +500 figures commits its charge after this request's
    // advisory lookup and before its function call. Before 0022 the credit was billed first and then
    // compensated back to draft; now the function refuses before billing anything.
    state.beforeRpc = () => {
      state.charges.push({ idempotency_key: KEY(), type: 'cam_true_up', lease_id: TENANT_LEASE_ID, amount: 500 })
    }
    const res = await approve(REC_ID)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/500\.00 is already posted.*-75\.00 \(a credit\).*NOT marked billed.*Delete that charge before approving the credit/)
    expect(state.rec?.status).toBe('draft')
    expect(state.rec?.notes).toBeUndefined()
  })

  it('a concurrent approval billed the row first: 400 already billed, and this request posted nothing', async () => {
    // Before 0022 this request's insert had already run, so it answered 409 "This request posted...".
    state.beforeRpc = () => { (state.rec as Row).status = 'billed' }
    const res = await approve(REC_ID)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('already billed')
    expect(chargesInsertSpy).not.toHaveBeenCalled()
    expect(state.charges).toHaveLength(0)
  })
})
