import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { TodayPage } from '../../src/pages/today/TodayPage'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })
const totals = { current: 0, d1_30: 0, d31_60: 6340.18, d61_90: 0, d90_plus: 0, unallocated: 0, balance: 6340.18 }
const arRows = [{
  lease_id: 'L3', tenant_id: 'T3', tenant_name: 'KC Brewing Supply', property_id: 'P', property_name: 'Raytown Flex', suite: '3',
  balance: 6340.18, buckets: { current: 0, d1_30: 0, d31_60: 6340.18, d61_90: 0, d90_plus: 0, unallocated: 0 },
}]
const fin = {
  income_statement: { period: { total_income: 1000, excluded: { security_deposits: 0 } } },
  cash_flow: { period: { total_cash_in: 874 } },
}
function healthy(): Record<string, unknown> {
  return { 'rent-roll': ok([]), 'ar-aging': ok({ data: arRows, totals }), 'critical-dates': ok([]), financials: ok(fin), collections: ok([]) }
}
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TodayPage)))

describe('TodayPage', () => {
  it('leads with the count and past-due dollars, then the ranked queue', () => {
    results.current = healthy()
    const html = render()
    expect(html).toContain('1 thing needs you.')
    expect(html).toContain('$6,340')
    expect(html).toContain('KC Brewing Supply: 31–60 days past due')
    expect(html).toContain('href="/tenants/T3"')
    expect(html).toContain('87.4%')
  })

  it('shows the error banner (not empty vitals) when a first read fails', () => {
    results.current = { ...healthy(), 'ar-aging': failed('Failed to load AR aging report') }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain('Failed to load AR aging report')
    expect(html).not.toContain('AR over 30 days')
  })

  it('has queue filter tabs with counts', () => {
    results.current = healthy()
    const html = render()
    for (const t of ['All', 'Collect', 'Renew', 'Comply']) expect(html).toContain(`>${t} <`)
    expect(html).toContain('role="tablist"')
  })
})
