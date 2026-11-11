// DELETE /api/charges/:id must not hard-delete the CAM true-up behind a billed reconciliation.
//
// approve_cam_reconciliation() (migration 0024) posts the true-up under cam_true_up:<lease>:<year>
// and marks the reconciliation billed in one transaction. Deleting that charge afterwards left the
// row billed with nothing on the ledger, and approve refuses a billed row (not_draft), so the
// true-up was lost with no path back. The route now refuses (409) while the matching reconciliation
// is billed or collected. A DRAFT reconciliation keeps the delete: approve's live_mismatch answer
// tells the user to delete a stale charge, and approve re-posts on the next run.
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

const LEASE = '11111111-1111-1111-1111-111111111111'
const OTHER_LEASE = '22222222-2222-2222-2222-222222222222'

type Recon = { status: string } | null
type ReconResult = { data: Recon; error: { code?: string; message: string } | null }

/** Wires `charges` (one pre-read row + delete spy) and `cam_reconciliations` (status per lease:year). */
function wire(
  charge: Record<string, unknown>,
  recons: Record<string, ReconResult>,
) {
  const deleteSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
  const chargeSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: charge, error: null }) }),
  })
  const reconLookups: string[] = []
  const reconSelect = vi.fn().mockImplementation(() => {
    const filters: Record<string, unknown> = {}
    const chain = {
      eq: vi.fn().mockImplementation((col: string, val: unknown) => {
        filters[col] = val
        return chain
      }),
      maybeSingle: vi.fn().mockImplementation(async () => {
        const key = `${filters.lease_id}:${filters.reconciliation_year}`
        reconLookups.push(key)
        return recons[key] ?? { data: null, error: null }
      }),
    }
    return chain
  })
  mockFrom.mockImplementation((table: string) => {
    if (table === 'charges') return { select: chargeSelect, delete: deleteSpy }
    if (table === 'cam_reconciliations') return { select: reconSelect }
    throw new Error(`unexpected table ${table}`)
  })
  return { deleteSpy, chargeSelect, reconLookups }
}

function camCharge(over: Record<string, unknown> = {}) {
  return {
    source: 'manual',
    voided_at: null,
    type: 'cam_true_up',
    lease_id: LEASE,
    period_start: '2025-01-01',
    idempotency_key: `cam_true_up:${LEASE}:2025`,
    ...over,
  }
}

const del = (id = 'chg_1') => app.request(`/api/charges/${id}`, { method: 'DELETE' }, env)

describe('DELETE /api/charges/:id — CAM true-up behind a billed reconciliation', () => {
  it('refuses (409) when the reconciliation is billed, points at void, and never deletes', async () => {
    const w = wire(camCharge(), { [`${LEASE}:2025`]: { data: { status: 'billed' }, error: null } })

    const res = await del()

    expect(res.status).toBe(409)
    const { error } = await res.json() as { error: string }
    expect(error).toMatch(/billed/i)
    expect(error).toMatch(/void/i)
    expect(w.deleteSpy).not.toHaveBeenCalled()
    expect(w.reconLookups).toContain(`${LEASE}:2025`)
  })

  it('refuses (409) when the reconciliation is collected', async () => {
    const w = wire(camCharge(), { [`${LEASE}:2025`]: { data: { status: 'collected' }, error: null } })

    const res = await del()

    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toMatch(/already collected/)
    expect(w.deleteSpy).not.toHaveBeenCalled()
  })

  it('tells the user a void is a database operation (there is no in-app void action)', async () => {
    wire(camCharge(), { [`${LEASE}:2025`]: { data: { status: 'billed' }, error: null } })

    const { error } = await (await del()).json() as { error: string }

    expect(error).toMatch(/administrator sets voided_at and void_reason/)
  })

  it('ignores a malformed (non-UUID) cam_true_up: key on a non-CAM charge instead of failing every delete', async () => {
    const w = wire(camCharge({ type: 'other', idempotency_key: 'cam_true_up:not-a-uuid:2025' }), {})

    const res = await del()

    expect(res.status).toBe(200)
    expect(w.reconLookups).toEqual([])
  })

  it('deletes when the reconciliation is still a draft (approve live_mismatch tells the user to delete)', async () => {
    const w = wire(camCharge(), { [`${LEASE}:2025`]: { data: { status: 'draft' }, error: null } })

    const res = await del()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(w.deleteSpy).toHaveBeenCalled()
  })

  it('deletes when no reconciliation exists for that lease/year', async () => {
    const w = wire(camCharge(), {})

    const res = await del()

    expect(res.status).toBe(200)
    expect(w.deleteSpy).toHaveBeenCalled()
  })

  it('fails CLOSED (500, no delete) when the reconciliation read errors', async () => {
    const w = wire(camCharge(), {
      [`${LEASE}:2025`]: { data: null, error: { code: '57014', message: 'statement timeout' } },
    })

    const res = await del()

    expect(res.status).toBe(500)
    expect(w.deleteSpy).not.toHaveBeenCalled()
    // The raw DB message stays server-side (dbError); the client gets only the public text.
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Failed to load CAM reconciliation')
    expect(JSON.stringify(body)).not.toContain('statement timeout')
  })

  it('checks the reconciliation named by the reserved key, even when the charge row disagrees', async () => {
    // A legacy row whose own lease/period differ from its key: approve looks the key up, so the key's
    // lease/year is the reconciliation that would be stranded.
    const w = wire(
      camCharge({ lease_id: OTHER_LEASE, period_start: '2024-01-01' }),
      { [`${LEASE}:2025`]: { data: { status: 'billed' }, error: null } },
    )

    const res = await del()

    expect(res.status).toBe(409)
    expect(w.deleteSpy).not.toHaveBeenCalled()
  })

  it('refuses a legacy cam_true_up with a non-reserved key when its lease/year reconciliation is billed', async () => {
    const w = wire(
      camCharge({ idempotency_key: 'legacy:abc' }),
      { [`${LEASE}:2025`]: { data: { status: 'billed' }, error: null } },
    )

    const res = await del()

    expect(res.status).toBe(409)
    expect(w.deleteSpy).not.toHaveBeenCalled()
  })

  it('refuses a non-CAM charge holding a reserved cam_true_up key when that reconciliation is billed', async () => {
    const w = wire(
      camCharge({ type: 'other' }),
      { [`${LEASE}:2025`]: { data: { status: 'billed' }, error: null } },
    )

    const res = await del()

    expect(res.status).toBe(409)
    expect(w.deleteSpy).not.toHaveBeenCalled()
  })

  it('fails CLOSED (409) on a cam_true_up whose reconciliation year cannot be determined', async () => {
    const w = wire(camCharge({ idempotency_key: 'legacy:abc', period_start: null }), {})

    const res = await del()

    expect(res.status).toBe(409)
    expect(w.deleteSpy).not.toHaveBeenCalled()
  })

  it('fails CLOSED when type is absent from the row (a dropped select must not disable the guard)', async () => {
    const { type: _t, idempotency_key: _k, ...row } = camCharge()
    void _t; void _k
    const w = wire(row, {})

    const res = await del()

    expect(res.status).toBe(500)
    expect(w.deleteSpy).not.toHaveBeenCalled()
  })

  it('selects every column the guard reads', async () => {
    const w = wire(camCharge(), { [`${LEASE}:2025`]: { data: { status: 'draft' }, error: null } })

    await del()

    const cols = w.chargeSelect.mock.calls[0][0] as string
    for (const col of ['source', 'voided_at', 'type', 'lease_id', 'period_start', 'idempotency_key']) {
      expect(cols).toContain(col)
    }
  })
})

describe('DELETE /api/charges/:id — non-CAM charges are untouched', () => {
  it('deletes an ordinary manual rent charge without reading cam_reconciliations', async () => {
    const w = wire({
      source: 'manual', voided_at: null, type: 'rent', lease_id: LEASE,
      period_start: '2025-03-01', idempotency_key: 'manual:xyz',
    }, {})

    const res = await del()

    expect(res.status).toBe(200)
    expect(w.deleteSpy).toHaveBeenCalled()
    expect(w.reconLookups).toEqual([])
  })

  it('still refuses auto charges (400) before any CAM lookup', async () => {
    const w = wire({ ...camCharge(), source: 'auto', type: 'rent', idempotency_key: 'auto:1' }, {})

    const res = await del()

    expect(res.status).toBe(400)
    expect(w.deleteSpy).not.toHaveBeenCalled()
  })
})
