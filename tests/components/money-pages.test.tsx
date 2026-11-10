import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ComponentType } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

// useQuery mocked by first key segment; for 'renewals' the second segment picks the response.
const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[opts.queryKey.slice(0, opts.queryKey[0] === 'renewals' ? 2 : 1).join(':')],
}))

import { RentRoll } from '../../src/pages/reports/RentRoll'
import { RenewalsPipeline } from '../../src/pages/renewals/RenewalsPipeline'
import { ARDashboard } from '../../src/pages/ar/ARDashboard'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })

const soon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10)
const rr = [
  { property_id: 'P1', property_name: 'Raytown Flex', unit_id: 'u3', suite: '3', sf: 24600, unit_status: 'occupied', tenant_id: 'T3',
    tenant_name: 'KC Brewing Supply', lease_id: 'L3', start_date: '2019-07-01', end_date: soon, lease_status: 'active',
    rent_type: 'nnn', base_rent_monthly: 20192.5, cam_estimate_monthly: 3170.09, total_monthly: 23362.59, rent_psf_annual: 9.85 },
  { property_id: 'P1', property_name: 'Raytown Flex', unit_id: 'u5', suite: '5', sf: 14400, unit_status: 'vacant', tenant_id: null,
    tenant_name: null, lease_id: null, start_date: null, end_date: null, lease_status: null,
    rent_type: null, base_rent_monthly: null, cam_estimate_monthly: null, total_monthly: null, rent_psf_annual: null },
]
const arRows = [
  { lease_id: 'L3', tenant_id: 'T3', unit_id: 'u3', tenant_name: 'KC Brewing Supply', property_id: 'P1', property_name: 'Raytown Flex', suite: '3',
    total_charged: 30000, total_paid: 11587.49, balance: 18412.51,
    buckets: { current: 12072.33, d1_30: 0, d31_60: 3170.09, d61_90: 3170.09, d90_plus: 0, unallocated: 0 } },
  { lease_id: 'L7', tenant_id: 'T7', unit_id: 'u7', tenant_name: 'Show-Me Logistics', property_id: 'P2', property_name: 'Columbia Trade Center', suite: '7',
    total_charged: 13300, total_paid: 0, balance: 13300, buckets: { current: 0, d1_30: 13300, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 } },
]
const totals = { current: 12072.33, d1_30: 13300, d31_60: 3170.09, d61_90: 3170.09, d90_plus: 0, unallocated: 0, balance: 31712.51 }

function render(Page: ComponentType, path: string) {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(Page))),
  )
}

describe('Rent roll (grouped default)', () => {
  it('groups by property with a subtotal, share bars, term bars and a portfolio total', () => {
    results.current = { 'rent-roll': ok(rr) }
    const html = render(RentRoll, '/rent-roll')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('▾ Raytown Flex')
    expect(html).toContain('39,000 SF · 63.1%')
    expect(html).toContain('href="/leases/L3"')
    expect(html).toContain('aria-label="Term Jul 1, 2019 to')
    expect(html).toContain('Portfolio total · 2 suites')
    expect(html).not.toContain('Export CSV')
  })
})

describe('Renewals (timeline and board)', () => {
  const recs = [{ id: 'R3', lease_id: 'L3', status: 'negotiating', expiration_date: soon, target_decision_date: null,
    leases: { tenants: { name: 'KC Brewing Supply' }, units: { suite: '3', properties: { name: 'Raytown Flex' } } } }]

  it('timeline: headline of rent rolling in 12 months and one lane per expiring lease', () => {
    results.current = { 'rent-roll': ok(rr), 'renewals:all': ok(recs) }
    const html = render(RenewalsPipeline, '/renewals')
    expect(html).toContain('$242k of base rent rolls in the next 12 months')
    expect(html).toContain('1 with a proposal out or in negotiation')
    expect(html).toContain('KC Brewing Supply: expires')
    expect(html).toContain('Negotiating')
  })

  it('board: status columns with the inline status select', () => {
    results.current = { 'rent-roll': ok(rr), 'renewals:all': ok(recs) }
    const html = render(RenewalsPipeline, '/renewals?view=board')
    expect(html).toContain('aria-label="Not tracked"')
    expect(html).toContain('aria-label="Negotiating"')
    expect(html).toContain('aria-label="Renewal status for KC Brewing Supply"')
  })

  it('shows the error banner when a read fails', () => {
    results.current = { 'rent-roll': ok(rr), 'renewals:all': failed('Failed to load renewals') }
    const html = render(RenewalsPipeline, '/renewals')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Failed to load renewals')
  })
})

describe('Collections', () => {
  it('leads with the amount owed, then the work queue (over-30 tab), then aging detail', () => {
    results.current = { 'ar-aging': ok({ data: arRows, totals }), collections: ok([]) }
    const html = render(ARDashboard, '/ar')
    expect(html).toContain('$31,712.51 owed by 2 tenants')
    expect(html).toContain('$6,340.18 is over 30 days, across 1 tenant')
    expect(html).toContain('Over 30 days · 1')
    expect(html).toContain('Past due · 2')
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('href="/tenants/T3"')
    expect(html).toContain('Aging detail')
    // Show-Me is past due but under 30 days, so it is not in the default tab's queue rows.
    expect(html.indexOf('Show-Me Logistics')).toBeGreaterThan(html.indexOf('Aging detail'))
  })
})
