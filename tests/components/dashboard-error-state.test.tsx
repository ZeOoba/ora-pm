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
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { Dashboard } from '../../src/pages/Dashboard'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })
const totals = { current: 100, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 50, unallocated: 0, balance: 150 }
const arOk = () => ok({ data: [], totals })
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
    expect(html).toContain('aria-label="Occupancy donut chart.')
    expect(html).toContain('aria-label="Lease expiry ladder')
    expect(html).toContain('aria-label="Portfolio AR aging')
    expect(html.match(/<table class="sr-only">/g)?.length).toBe(3)
    expect(html).toContain('grid-cols-1 md:grid-cols-2 xl:grid-cols-4')
    expect(html).toContain('$150')
  })
})
