import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from '../../server/index'
import { pgTable, type Row } from '../fixtures/pg-table'

const admin = vi.hoisted(() => ({ email: 'bookkeeper@example.test' as string | undefined }))
vi.mock('../../server/middleware/admin-auth', () => ({
  adminAuthMiddleware: vi.fn(async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    if (admin.email) c.set('adminEmail', admin.email)
    return next()
  }),
}))
const mockFrom = vi.hoisted(() => vi.fn())
const mockRpc = vi.hoisted(() => vi.fn())
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mockFrom, rpc: mockRpc }) }))

const env = { SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test', CRON_SECRET: 'x', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }
const app = createApp()
const LLC = 'Example Flex, LLC'
const L1 = 'b0300000-0000-4000-8000-000000000001'
const L2 = 'b0300000-0000-4000-8000-000000000002'
const L3 = 'b0300000-0000-4000-8000-000000000003'

const post = (body: unknown) => app.request('/api/balance-forwards/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
const csv = [
  ',Example Flex LLC', ',A/R Aging Summary', ',"As of November 12, 2026"', '',
  ',,Current,1 - 30,31 - 60,61 - 90,> 90,TOTAL',
  'Pool Supply Co,,0.00,0.00,0.00,0.00,"1,500.00","1,500.00"',
  'TOTAL,,0.00,0.00,0.00,0.00,"1,500.00","1,500.00"',
].join('\r\n')

let tables: Record<string, ReturnType<typeof pgTable>>
function world(over: { charges?: Row[]; payments?: Row[]; ledger?: Row[] } = {}) {
  const ledgerRow = (lease_id: string, tenant_name: string, property_id: string, extra: Row = {}): Row => ({
    lease_id, tenant_name, suite: 'A', property_id, property_name: property_id === 'p1' ? '100 Example Dr' : 'Other Park', balance_forward: 0, balance_forward_as_of: null, ...extra,
  })
  tables = {
    properties: pgTable([{ id: 'p1', entity_llc: LLC }, { id: 'p2', entity_llc: 'Other LLC' }, { id: 'p3', entity_llc: null }, { id: 'p4', entity_llc: `${LLC} ` }, { id: 'p5', entity_llc: '  ' }]),
    ar_ledger: pgTable(over.ledger ?? [ledgerRow(L1, 'Pool Supply Co', 'p1'), ledgerRow(L2, 'Quiet Tenant', 'p1'), ledgerRow(L3, 'Elsewhere Inc', 'p2')]),
    leases: pgTable([{ id: L1, status: 'active' }, { id: L2, status: 'expired' }, { id: L3, status: 'active' }]),
    charges: pgTable(over.charges ?? [
      { id: 'c1', lease_id: L1, amount: '1000.00', charge_date: '2026-10-01', voided_at: null },
      { id: 'c2', lease_id: L1, amount: '1000.00', charge_date: '2026-11-01', voided_at: null },
      { id: 'c3', lease_id: L1, amount: '1000.00', charge_date: '2026-12-01', voided_at: null }, // after the cut-off
      { id: 'c4', lease_id: L1, amount: '50.00', charge_date: '2026-10-05', voided_at: '2026-10-06T00:00:00Z' }, // voided
      { id: 'c5', lease_id: L2, amount: '200.00', charge_date: '2026-09-01', voided_at: null },
    ]),
    payments: pgTable(over.payments ?? [
      { id: 'y1', lease_id: L1, amount: '400.00', payment_date: '2026-10-10', method: 'check', stripe_status: null },
      { id: 'y2', lease_id: L1, amount: '99.00', payment_date: '2026-10-11', method: 'ach_stripe', stripe_status: 'failed' },
    ]),
    balance_forwards: pgTable([]),
  }
  mockFrom.mockImplementation((t: string) => {
    if (!tables[t]) throw new Error(`unexpected table ${t}`)
    return tables[t]
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  admin.email = 'bookkeeper@example.test'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 10, 13, 18, 0, 0))
  mockRpc.mockResolvedValue({ data: [{ id: 'bf-1' }], error: null })
  world()
})
afterEach(() => { vi.useRealTimers() })

type Plan = { rows: { lease_id: string; qb_cents: number; app_cents: number; adjustment_cents: number; status: string; qb_source: string }[]; errors: string[]; warnings: string[]; plan_hash: string; adjust_count: number; applied: boolean }

describe('GET /api/balance-forwards/llcs', () => {
  it('lists the exact LLC names on properties with their property counts (a stray space shows as its own entry)', async () => {
    const res = await app.request('/api/balance-forwards/llcs', {}, env)
    expect(await res.json()).toEqual({ data: [{ name: LLC, properties: 1 }, { name: `${LLC} `, properties: 1 }, { name: 'Other LLC', properties: 1 }] })
  })
})

describe('POST /api/balance-forwards/plan', () => {
  it('preview: only the LLC’s leases; app balance as of the cut-off with ar_ledger’s rules; QuickBooks − app', async () => {
    const res = await post({ llc: LLC, as_of: '2026-11-12', csv })
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: Plan }
    expect(data.errors).toEqual([])
    // L1: 1,000 + 1,000 (Dec and the voided fee excluded) − 400 (failed ACH excluded) = 1,600; QuickBooks 1,500.
    // L2: absent from the file → QuickBooks 0; app 200.
    expect(data.rows.map((r) => [r.lease_id, r.qb_cents, r.app_cents, r.adjustment_cents, r.status, r.qb_source])).toEqual([
      [L1, 150000, 160000, -10000, 'adjust', 'file'],
      [L2, 0, 20000, -20000, 'adjust', 'absent_from_file'],
    ])
    expect(data.plan_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(mockRpc).not.toHaveBeenCalled()
    const chargeFilters = tables.charges.pages[0]
    expect(chargeFilters).toContainEqual({ method: 'lte', args: ['charge_date', '2026-11-12'] })
    expect(chargeFilters).toContainEqual({ method: 'is', args: ['voided_at', null] })
  })

  it('apply: needs the preview’s hash and an identified admin; writes only adjusted rows through the RPC', async () => {
    const preview = (await (await post({ llc: LLC, as_of: '2026-11-12', csv, file_name: 'aging.csv' })).json() as { data: Plan }).data
    expect((await post({ llc: LLC, as_of: '2026-11-12', csv, apply: true, expected_plan_hash: 'stale' })).status).toBe(409)
    admin.email = undefined
    expect((await post({ llc: LLC, as_of: '2026-11-12', csv, apply: true, expected_plan_hash: preview.plan_hash })).status).toBe(403)
    admin.email = 'bookkeeper@example.test'
    expect(mockRpc).not.toHaveBeenCalled()

    const res = await post({ llc: LLC, as_of: '2026-11-12', csv, file_name: 'aging.csv', apply: true, expected_plan_hash: preview.plan_hash })
    expect(res.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith('apply_balance_forwards', {
      p_as_of: '2026-11-12', p_source: 'qb_ar_aging', p_source_ref: 'aging.csv', p_actor: 'bookkeeper@example.test',
      p_rows: [
        { lease_id: L1, qb_balance: 1500, expected_app_balance: 1600, qb_customer: 'Pool Supply Co' },
        { lease_id: L2, qb_balance: 0, expected_app_balance: 200, qb_customer: null },
      ],
    })
  })

  it('a different figure changes the hash (the apply must match what was reviewed)', async () => {
    const a = (await (await post({ llc: LLC, as_of: '2026-11-12', csv })).json() as { data: Plan }).data
    const b = (await (await post({ llc: LLC, as_of: '2026-11-12', csv, manual: { [L2]: 5000 } })).json() as { data: Plan }).data
    expect(a.plan_hash).not.toBe(b.plan_hash)
  })

  it.each(['processing', 'requires_action'])('refuses to apply a plan with errors (an ACH %s before the cut-off) and never calls the RPC', async (status) => {
    world({ payments: [{ id: 'y3', lease_id: L1, amount: '10.00', payment_date: '2026-11-01', method: 'ach_stripe', stripe_status: status }] })
    const preview = await post({ llc: LLC, as_of: '2026-11-12', csv })
    expect(preview.status).toBe(422)
    const { data } = await preview.json() as { data: Plan }
    expect(data.errors.join()).toMatch(/still processing/)
    const res = await post({ llc: LLC, as_of: '2026-11-12', csv, apply: true, expected_plan_hash: data.plan_hash })
    expect(res.status).toBe(422)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('maps the database’s refusals: a moved balance → 409, a rule → 422', async () => {
    const { data } = await (await post({ llc: LLC, as_of: '2026-11-12', csv })).json() as { data: Plan }
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'bf: lease x: the app balance as of 2026-11-12 is now 1700, not 1600 as previewed; preview again' } })
    const moved = await post({ llc: LLC, as_of: '2026-11-12', csv, apply: true, expected_plan_hash: data.plan_hash })
    expect(moved.status).toBe(409)
    expect(((await moved.json()) as { error: string }).error).toBe('lease x: the app balance as of 2026-11-12 is now 1700, not 1600 as previewed; preview again')
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'bf: lease x: its LLC is already tied out in the ledger' } })
    expect((await post({ llc: LLC, as_of: '2026-11-12', csv, apply: true, expected_plan_hash: data.plan_hash })).status).toBe(422)
    // Anything not written for the user stays generic.
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'new row violates check constraint "balance_forwards_amount_nonzero"' } })
    const raw = await post({ llc: LLC, as_of: '2026-11-12', csv, apply: true, expected_plan_hash: data.plan_hash })
    expect(raw.status).toBe(500)
    expect(((await raw.json()) as { error: string }).error).toBe('Failed to apply the balance forwards')
  })

  it.each([
    [{ as_of: '2026-11-12' }, /llc is required/],
    [{ llc: LLC, as_of: '11/12/2026' }, /as_of must be/],
    [{ llc: LLC, as_of: '2026-11-12', manual: { [L1]: '5' } }, /manual must map/],
    [{ llc: LLC, as_of: '2026-11-12', assign: { A: 5 } }, /assign must map/],
  ])('rejects a malformed request %#', async (body, msg) => {
    const res = await post(body)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toMatch(msg)
  })
})

describe('POST /api/balance-forwards/:id/void', () => {
  const id = 'c79d005e-e41e-4aa4-8d33-d795687c8ec4'
  const voidReq = (body: unknown) => app.request(`/api/balance-forwards/${id}/void`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
  it('needs a reason and an admin; calls void_balance_forward', async () => {
    expect((await voidReq({})).status).toBe(422)
    admin.email = undefined
    expect((await voidReq({ reason: 'wrong figure' })).status).toBe(403)
    admin.email = 'bookkeeper@example.test'
    mockRpc.mockResolvedValueOnce({ data: { id }, error: null })
    expect((await voidReq({ reason: ' wrong figure ' })).status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('void_balance_forward', { p_id: id, p_actor: 'bookkeeper@example.test', p_reason: 'wrong figure' })
  })
})
