import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

// Keyed by the first two queryKey segments ("collections:promises"), else by the first.
const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) =>
    results.current[opts.queryKey.slice(0, 2).join(':')] ?? results.current[String(opts.queryKey[0])],
}))

import { indexByLease, type DisputeRecord, type PromiseRecord } from '../../src/pages/money/collections-records'
import { collectionsFilter } from '../../src/pages/money/money-derive'
import { buildQueue } from '../../src/pages/today/today-queue'
import { ARDashboard } from '../../src/pages/ar/ARDashboard'
import { TenantCollectionsCard } from '../../src/pages/money/TenantCollectionsCard'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })

const promise = (id: string, lease: string, date: string, lapsed: boolean, status: PromiseRecord['status'] = 'open'): PromiseRecord => ({
  id, lease_id: lease, amount: 6340.18, promised_date: date, status, notes: 'Dana, by phone', created_by: 'mk@example.test',
  created_at: '2026-10-30T00:00:00Z', resolved_at: null, lapsed,
})
const dispute = (id: string, lease: string, created: string): DisputeRecord => ({
  id, lease_id: lease, amount: 9880, reason: 'CAM 2025 reconciliation', status: 'open', resolution: null,
  created_by: 'gg@example.test', created_at: created, resolved_at: null,
})

const z = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 }
const ar = (lease: string, tenant: string, b: Partial<typeof z>) => {
  const buckets = { ...z, ...b }
  return { lease_id: lease, tenant_id: tenant, unit_id: `u-${lease}`, tenant_name: `Tenant ${tenant}`, property_id: 'P', property_name: 'Raytown Flex', suite: lease,
    total_charged: 0, total_paid: 0, balance: Object.values(buckets).reduce((s, v) => s + v, 0), buckets }
}

const render = (node: ReactElement) => renderToStaticMarkup(
  createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, node)),
)

describe('indexByLease', () => {
  it('keeps the earliest open promise and the oldest open dispute per lease; ignores resolved', () => {
    const idx = indexByLease(
      [promise('p2', 'L1', '2026-12-01', false), promise('p1', 'L1', '2026-11-05', true), promise('p3', 'L2', '2026-01-01', false, 'kept')],
      [dispute('d2', 'L1', '2026-11-01'), dispute('d1', 'L1', '2026-10-01')],
    )
    expect(idx.get('L1')?.promise?.id).toBe('p1')
    expect(idx.get('L1')?.dispute?.id).toBe('d1')
    expect(idx.has('L2')).toBe(false)
  })
})

describe('queue integration', () => {
  const rows = [ar('A', 'TA', { d90_plus: 500 }), ar('B', 'TB', { d1_30: 100 }), ar('C', 'TC', { d31_60: 50 })]
  const records = indexByLease([promise('p', 'B', '2026-11-05', true)], [dispute('d', 'C', '2026-10-01')])

  it('Collections: a lapsed promise jumps the queue; Promised and Disputed tabs filter by record', () => {
    expect(collectionsFilter(rows, 'pastDue', records).map((r) => r.lease_id)).toEqual(['B', 'A', 'C'])
    expect(collectionsFilter(rows, 'promised', records).map((r) => r.lease_id)).toEqual(['B'])
    expect(collectionsFilter(rows, 'disputed', records).map((r) => r.lease_id)).toEqual(['C'])
  })

  it('Today: a lapsed promise makes the Collect item urgent and says so; a dispute is noted', () => {
    const q = buildQueue({ ar: rows, rentRoll: [], dates: [], today: '2026-11-10', records })
    const b = q.find((i) => i.key === 'collect:B')
    expect(b?.urgent).toBe(true)
    expect(b?.title).toBe('Tenant TB: promise to pay lapsed')
    expect(b?.context).toContain('promise lapsed $6,340.18 by 11/05')
    expect(q.find((i) => i.key === 'collect:C')?.context).toContain('disputed')
  })
})

describe('Collections page with records', () => {
  const totals = { ...z, d1_30: 100, d31_60: 50, d90_plus: 500, balance: 650 }
  const data = { data: [ar('A', 'TA', { d90_plus: 500 }), ar('B', 'TB', { d1_30: 100 })], totals }

  it('shows the promise on its row, the Log… action, and the new tabs', () => {
    results.current = { 'ar-aging': ok(data), 'collections:promises': ok([promise('p', 'B', '2026-11-05', true)]), 'collections:disputes': ok([]) }
    const html = render(createElement(ARDashboard))
    expect(html).toContain('Promised · 1')
    expect(html).toContain('Disputed · 0')
    expect(html).toContain('>Log…<')
  })

  it('a failed records read degrades to balances with a notice, never a blocking error', () => {
    results.current = { 'ar-aging': ok(data), 'collections:promises': failed('boom'), 'collections:disputes': ok([]) }
    const html = render(createElement(ARDashboard))
    expect(html).toContain('load promises and disputes; the queue below shows balances only')
    expect(html).toContain('owed by 2 tenants')
  })
})

describe('TenantCollectionsCard', () => {
  it('lists open records with their resolve actions, and says it changes no balance', () => {
    results.current = { 'collections:promises': ok([promise('p', 'L1', '2026-11-05', true)]), 'collections:disputes': ok([dispute('d', 'L1', '2026-10-30')]) }
    const html = render(createElement(TenantCollectionsCard, { tenantId: 't1', leases: [{ id: 'L1', label: 'Raytown Flex · 3' }, { id: 'L2', label: 'Raytown Flex · 4' }] }))
    expect(html).toContain('PROMISE LAPSED · Raytown Flex · 3')
    expect(html).toContain('$6,340.18 by Nov 5, 2026')
    for (const s of ['kept', 'broken', 'cancelled', 'resolved', 'withdrawn']) expect(html).toContain(`>${s}<`)
    expect(html).toContain('DISPUTED · Raytown Flex · 3')
    expect(html).toContain('aria-label="Lease to log against"')
    expect(html).toContain('does not change the balance or pause late fees')
  })

  it('empty state', () => {
    results.current = { 'collections:promises': ok([]), 'collections:disputes': ok([]) }
    expect(render(createElement(TenantCollectionsCard, { tenantId: 't1', leases: [] }))).toContain('No open promises or disputes.')
  })
})
