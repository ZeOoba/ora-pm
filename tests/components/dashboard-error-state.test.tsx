import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

// Mocked query results keyed by the first queryKey segment.
const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = String(opts.queryKey[0])
    return key in results.current ? results.current[key] : defaults()[key]
  },
}))

import { Dashboard } from '../../src/pages/Dashboard'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })
const totals = { current: 100, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 50, unallocated: 0, balance: 150 }
const arOk = () => ok({ data: [], totals })
const fin = {
  range: { from: '2026-11-01', to: '2026-11-09' },
  fytd_range: { from: '2026-01-01', to: '2026-11-09' },
  income_statement: { period: { total_income: 42299.63, excluded: { security_deposits: 0 } }, fytd: { total_income: 0 } },
  cash_flow: { period: { total_cash_in: 35511.7, pending_ach: 0 }, fytd: {} },
}
const activity = {
  data: [
    { id: 'p1', kind: 'cash_in', date: '2026-11-09', party: 'Adkins Towing', property_id: 'P', property_name: 'nbc-a', suite: '08A', description: 'Check', amount: 705.55, running_net: 465.55 },
    { id: 'e1', kind: 'cash_out', date: '2026-11-04', party: 'Host Co', property_id: 'P', property_name: 'nbc-a', suite: null, description: 'Other expense', amount: -240, running_net: -240 },
  ],
  totals: { cash_in: 21742.54, cash_out: 4241.46, net: 17501.08, pending_ach: 0 },
  range: { from: '2026-11-01', to: '2026-11-09' },
}
// The AppFolio-style queries succeed unless a test overrides them in results.current.
function defaults(): Record<string, unknown> {
  return { financials: ok(fin), 'cash-activity': ok(activity), properties: ok([]) }
}
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Dashboard)))

describe('Dashboard error state', () => {
  it('shows the error banner (not $0 KPIs) when the AR query fails', () => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': failed('Failed to load AR aging report') }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain('Failed to load AR aging report')
    expect(html).not.toContain('Outstanding AR')
    expect(html).not.toContain('Portfolio is healthy')
  })

  it.each(['rent-roll', 'critical-dates'])('shows the banner when %s fails', (key) => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': arOk(), [key]: failed(`boom ${key}`) }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain(`boom ${key}`)
  })

  it('error with data (failed refetch) keeps the KPIs and shows a non-blocking warning', () => {
    const stale = { isPending: false, isLoading: false, isError: true, error: new Error('refetch boom'), data: [], refetch: vi.fn() }
    results.current = { 'rent-roll': stale, 'critical-dates': ok([]), 'ar-aging': arOk() }
    const html = render()
    expect(html).not.toContain('role="alert"')
    expect(html).toContain('showing last loaded data')
    expect(html).toContain('Outstanding AR')
  })

  it('mixed: one first-load failure blocks even when another query has stale data', () => {
    const stale = { isPending: false, isLoading: false, isError: true, error: new Error('stale'), data: [], refetch: vi.fn() }
    results.current = { 'rent-roll': stale, 'critical-dates': failed('first load boom'), 'ar-aging': arOk() }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain('first load boom')
    expect(html).not.toContain('Outstanding AR')
  })

  it('labels unit occupancy (KPI) and SF occupancy (donut) as distinct metrics', () => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': arOk() }
    const html = render()
    expect(html).toContain('% Occupied')
    expect(html).toContain('occupied units ÷ all units')
    expect(html).toContain('SF occupancy')
    expect(html).toContain('aria-label="SF occupancy donut chart.')
  })

  it('feeds excluded-lease counts into the ladder caption (visible and sr-only)', () => {
    const year = new Date().getFullYear()
    const rr = [
      { unit_id: 'u1', sf: 1000, unit_status: 'occupied', lease_id: 'l1', end_date: null, total_monthly: 10 },
      { unit_id: 'u2', sf: 500, unit_status: 'occupied', lease_id: 'l2', end_date: `${year - 1}-01-31`, total_monthly: 10 },
    ]
    results.current = { 'rent-roll': ok(rr), 'critical-dates': ok([]), 'ar-aging': arOk() }
    const html = render()
    const note = `Excludes 1 lease with no end date and 1 active lease that ended before ${year} (holdover).`
    expect(html.split(note).length - 1).toBeGreaterThanOrEqual(2)
  })

  it('renders KPIs when every query succeeds', () => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': arOk() }
    const html = render()
    expect(html).not.toContain('role="alert"')
    expect(html).toContain('Outstanding AR')
  })

  it('renders the three charts with aria-labels and sr-only table fallbacks', () => {
    const year = new Date().getFullYear()
    const rr = [
      { unit_id: 'u1', sf: 1000, unit_status: 'occupied', lease_id: 'l1', end_date: `${year + 1}-03-31`, total_monthly: 10 },
      { unit_id: 'u2', sf: 500, unit_status: 'vacant', lease_id: null, end_date: null, total_monthly: null },
    ]
    results.current = { 'rent-roll': ok(rr), 'critical-dates': ok([]), 'ar-aging': arOk() }
    const html = render()
    expect(html).toContain('aria-label="SF occupancy donut chart.')
    expect(html).toContain('aria-label="Lease expiry ladder')
    expect(html).toContain('aria-label="Portfolio AR aging')
    // 3 portfolio charts + 2 gauges, each with an sr-only table fallback
    expect(html.match(/<table class="sr-only">/g)?.length).toBe(5)
    expect(html).toContain('grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4')
    expect(html).toContain('$150')
  })

  it.each(['financials', 'cash-activity'])('blocks the money tiles (no $0 Cash In) when %s fails', (key) => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': arOk(), [key]: failed(`cash boom ${key}`) }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain(`cash boom ${key}`)
    expect(html).not.toContain('Cash In')
  })

  it('renders AppFolio-style money tiles, gauges and recent cash in/out', () => {
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': arOk() }
    const html = render()
    expect(html).toContain('$21,742.54')
    expect(html).toContain('$4,241.46')
    expect(html).toContain('border-l-status-active')
    expect(html).toContain('84% of billed (incl. deposits) collected')
    expect(html).toContain('aria-label="Rent Collected:')
    expect(html).toContain('Adkins Towing')
    expect(html).toContain('Host Co')
    expect(html).toContain('/transactions?type=cash_in')
  })

  it('counts billed deposits in the Rent Collected denominator (no >100% from a deposit receipt)', () => {
    const depositFin = {
      ...fin,
      income_statement: { period: { total_income: 10000, excluded: { security_deposits: 10000 } }, fytd: { total_income: 0 } },
      cash_flow: { period: { total_cash_in: 20000, pending_ach: 0 }, fytd: {} },
    }
    results.current = { 'rent-roll': ok([]), 'critical-dates': ok([]), 'ar-aging': arOk(), financials: ok(depositFin) }
    const html = render()
    expect(html).toContain('100% of billed (incl. deposits) collected')
    expect(html).not.toContain('200%')
  })
})
