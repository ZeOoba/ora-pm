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

import { PortfolioOverview } from '../../src/pages/portfolio/PortfolioOverview'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })
const rr = [
  { property_id: 'P1', property_name: 'Raytown Flex', unit_id: 'u1', suite: '3', sf: 24600, unit_status: 'occupied', tenant_id: 'T3',
    tenant_name: 'KC Brewing Supply', lease_id: 'L3', start_date: '2019-07-01', end_date: '2027-06-30', lease_status: 'active',
    rent_type: 'nnn', base_rent_monthly: 20192.5, cam_estimate_monthly: 0, total_monthly: 20192.5, rent_psf_annual: 9.85 },
]
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PortfolioOverview)))

describe('PortfolioOverview', () => {
  it('renders the masthead, one row per property linking to it, and rent at risk by quarter', () => {
    results.current = { 'rent-roll': ok(rr), 'ar-aging': ok({ data: [], totals: {} }) }
    const html = render()
    expect(html).toContain('The Portfolio')
    expect(html).toContain('href="/properties/P1"')
    expect(html).toContain('Raytown Flex')
    expect(html).toContain('$242k')
    expect(html).toContain('Ste 3 · Jun 2027')
    expect(html).toContain('aria-label="Annual base rent expiring by quarter')
  })

  it('shows the error banner when a read fails', () => {
    results.current = { 'rent-roll': ok(rr), 'ar-aging': failed('Failed to load AR aging report') }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('href="/properties/P1"')
  })
})
