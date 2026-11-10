// tests/routes/mass-assignment.test.ts
//
// OI-041 remainder (Task 9): the 7 remaining CRUD mass-assignment sites named
// in the plan — budgets upsert, insurance insert/update, unit insert/update,
// renewal update, lease-amendment insert — each retrofitted onto a `.strict()`
// Zod schema (server/lib/schemas.ts) behind the safeParse -> 422 pattern
// (leases.ts:40-41's existing convention).
//
// RED shape per site: valid fields + an attacker-controlled `id`/`created_at`
// -> 422, and the underlying insert/update mock must never be called (proves
// the extra keys never reach Supabase, not just that they get silently
// stripped before the response). lease-amendment notices and tenant
// correspondence (the two "already hand-destructured" sites) get the same
// treatment in their own existing test files (notices.test.ts,
// correspondence.test.ts) rather than duplicated here.
//
// Charges gap closure (OI-046): migration 0011 made charges.idempotency_key
// NOT NULL with no DB default; the plain POST /api/charges route never had a
// field for it at all, so every insert through it currently violates that
// constraint. Covered at the bottom of this file.

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

const UUID_1 = '11111111-1111-1111-1111-111111111111'
const UUID_2 = '22222222-2222-2222-2222-222222222222'

// Generic single-row insert/update mock: resolves `select().single()` with
// `{ data: { id: 'new_1', ...row } }` and records every row it was called
// with via `spy`.
function tableMock(spy: (row: unknown) => void, resultRow: Record<string, unknown> = {}) {
  const chain = {
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: { id: 'new_1', ...resultRow }, error: null }),
    }),
  }
  return {
    insert: vi.fn().mockImplementation((row: unknown) => { spy(row); return chain }),
    update: vi.fn().mockImplementation((row: unknown) => {
      spy(row)
      return { eq: vi.fn().mockReturnValue(chain) }
    }),
    upsert: vi.fn().mockImplementation((row: unknown) => { spy(row); return chain }),
  }
}

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

function put(path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

// ---------------------------------------------------------------------------
// 1) budgets.ts:25 — upsert
// ---------------------------------------------------------------------------
describe('POST /api/budgets', () => {
  const VALID = { property_id: UUID_1, year: 2026, category: 'taxes', budgeted_amount: 1000 }

  it('accepts a valid budget row', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    const res = await post('/api/budgets', VALID)
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledWith(VALID)
  })

  it('rejects an unexpected field (id, created_at) with 422 and never calls upsert', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await post('/api/budgets', { ...VALID, id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  // RED — Supabase's .upsert() accepts an array body natively; the route
  // used to hand the raw parsed JSON straight to it with no row-count bound.
  it('rejects a 51-element batch array with 422 and never calls upsert', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await post('/api/budgets', Array.from({ length: 51 }, (_, i) => ({ ...VALID, category: i % 2 === 0 ? 'taxes' : 'insurance' })))
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  it('accepts a batch array at the cap (10 categories, well under 50)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const categories = ['rental_income', 'cam_income', 'other_income', 'taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other']
    const res = await post('/api/budgets', categories.map(category => ({ ...VALID, category })))
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 2) insurance.ts:35 (insert), insurance.ts:46 (update)
// ---------------------------------------------------------------------------
describe('POST /api/insurance', () => {
  const VALID = {
    tenant_id: UUID_1, policy_type: 'general_liability',
    effective_date: '2026-01-01', expiration_date: '2027-01-01',
  }

  it('accepts a valid certificate', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    const res = await post('/api/insurance', VALID)
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledWith(VALID)
  })

  it('rejects an unexpected field (id, created_at) with 422 and never calls insert', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await post('/api/insurance', { ...VALID, id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  // A client-set `status` would bypass the GET-time computed enrichment —
  // excluded from the schema entirely, so it 422s like any other unknown key.
  it('rejects a client-supplied status field with 422', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await post('/api/insurance', { ...VALID, status: 'active' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('PUT /api/insurance/:id', () => {
  it('accepts a partial update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, { carrier: 'Travelers' }))
    const res = await put(`/api/insurance/${UUID_1}`, { carrier: 'Travelers' })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith({ carrier: 'Travelers' })
  })

  it('rejects an unexpected field (id, created_at) with 422 and never calls update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await put(`/api/insurance/${UUID_1}`, { carrier: 'Travelers', id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3) units.ts:20 (insert), units.ts:28 (update)
// ---------------------------------------------------------------------------
describe('POST /api/units', () => {
  const VALID = { property_id: UUID_1, suite: '101', sf: 1200, status: 'vacant' }

  it('accepts a valid unit', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    const res = await post('/api/units', VALID)
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledWith(VALID)
  })

  it('rejects an unexpected field (id, created_at) with 422 and never calls insert', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await post('/api/units', { ...VALID, id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('PUT /api/units/:id', () => {
  it('accepts a partial update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, { status: 'occupied' }))
    const res = await put(`/api/units/${UUID_1}`, { status: 'occupied' })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith({ status: 'occupied' })
  })

  it('rejects an unexpected field (id, created_at) with 422 and never calls update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await put(`/api/units/${UUID_1}`, { status: 'occupied', id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4) renewals.ts:22 — update
// ---------------------------------------------------------------------------
describe('PUT /api/renewals/:id', () => {
  it('accepts a status + notes update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, { status: 'negotiating', notes: 'Sent counter' }))
    const res = await put(`/api/renewals/${UUID_1}`, { status: 'negotiating', notes: 'Sent counter' })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ status: 'negotiating', notes: 'Sent counter' }))
  })

  it('rejects an unexpected field (id, created_at) with 422 and never calls update', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await put(`/api/renewals/${UUID_1}`, { status: 'negotiating', id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  // lease_id re-pointing a renewal record to a different lease is exactly
  // the kind of column the UI never exposes but an admin JWT could otherwise set.
  it('rejects a client-supplied lease_id with 422', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await put(`/api/renewals/${UUID_1}`, { status: 'negotiating', lease_id: UUID_2 })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5) leases.ts:74 — lease_amendments insert
// ---------------------------------------------------------------------------
describe('POST /api/leases/:id/amendments', () => {
  const VALID = { effective_date: '2026-06-01', description: 'Rent escalation to $4,800/mo' }

  it('accepts a valid amendment', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    const res = await post(`/api/leases/${UUID_1}/amendments`, VALID)
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ...VALID, lease_id: UUID_1 }))
  })

  it('rejects an unexpected field (id, created_at) with 422 and never calls insert', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await post(`/api/leases/${UUID_1}/amendments`, { ...VALID, id: 'attacker-uuid', created_at: '1999-01-01' })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })

  // lease_id must come from the URL, never the body — a body-supplied
  // lease_id could otherwise attach the amendment to a different lease.
  it('rejects a client-supplied lease_id with 422', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy))
    const res = await post(`/api/leases/${UUID_1}/amendments`, { ...VALID, lease_id: UUID_2 })
    expect(res.status).toBe(422)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// OI-046 gap closure — POST /api/charges idempotency_key default
// ---------------------------------------------------------------------------
describe('POST /api/charges — idempotency_key gap closure (OI-046)', () => {
  const VALID = {
    lease_id: UUID_1,
    charge_date: '2026-06-01',
    due_date: '2026-06-05',
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    type: 'other',
    amount: 250,
  }

  // RED — fails today: ChargeInsertSchema has no idempotency_key field at
  // all, so the insert call would carry no such column and would violate
  // migration 0011's NOT NULL constraint against a real database.
  it('defaults idempotency_key to manual:<uuid> when the client omits it', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    const res = await post('/api/charges', VALID)
    expect(res.status).toBe(201)
    expect(spy).toHaveBeenCalledTimes(1)
    const inserted = spy.mock.calls[0][0] as { idempotency_key: string }
    expect(inserted.idempotency_key).toMatch(/^manual:[0-9a-f-]{36}$/)
  })

  // RED — a client-supplied idempotency_key (e.g. an admin UI dedupe-ing a
  // double-click/retry by resending the same value) must pass through
  // unchanged, not be overwritten by the server default.
  it('passes a client-supplied idempotency_key through unchanged', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    const res = await post('/api/charges', { ...VALID, idempotency_key: 'manual:client-retry-token-1' })
    expect(res.status).toBe(201)
    const inserted = spy.mock.calls[0][0] as { idempotency_key: string }
    expect(inserted.idempotency_key).toBe('manual:client-retry-token-1')
  })

  // REFUTE 0024 (C1b): a hand-posted cam_true_up is invisible to approve_cam_reconciliation(), which
  // only sees the reserved cam_true_up:<lease>:<year> key: approving the draft would double-charge.
  it.each([
    ['type cam_true_up with a generated key', { ...VALID, type: 'cam_true_up' }],
    ['type cam_true_up with a manual key', { ...VALID, type: 'cam_true_up', idempotency_key: 'manual:x' }],
    ['a reserved cam_true_up: key on another type', { ...VALID, idempotency_key: `cam_true_up:${UUID_1}:2025` }],
  ])('refuses %s (422, nothing inserted)', async (_name, body) => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    const res = await post('/api/charges', body)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(/only by approving the CAM reconciliation/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('two calls without a client key each get a distinct generated key (no accidental collision)', async () => {
    const spy = vi.fn()
    mockFrom.mockReturnValue(tableMock(spy, VALID))
    await post('/api/charges', VALID)
    await post('/api/charges', VALID)
    const key1 = (spy.mock.calls[0][0] as { idempotency_key: string }).idempotency_key
    const key2 = (spy.mock.calls[1][0] as { idempotency_key: string }).idempotency_key
    expect(key1).not.toBe(key2)
  })
})
