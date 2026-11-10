import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: { auth: { getSession: vi.fn(), signOut: vi.fn(), mfa: {} }, storage: {} },
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { PortalHomeView, type PortalHomeData } from '../../src/portal/components/PortalHomeView'
import { PortalDashboard } from '../../src/portal/pages/PortalDashboard'
import { TenantPortalPreview } from '../../src/pages/tenants/TenantPortalPreview'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })

const zero = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 }
// Aged balance 18,662.51 on one lease; a 250.00 credit on another lease, so total_balance = 18,412.51.
const aging = {
  data: [{ lease_id: 'l1', property_name: 'Raytown Flex', suite: '3', balance: 18662.51, buckets: { ...zero, current: 12322.33, d31_60: 3170.09, d61_90: 3170.09 } }],
  totals: { ...zero, current: 12322.33, d31_60: 3170.09, d61_90: 3170.09, balance: 18662.51 },
}
const lease = { id: 'l1', end_date: '2027-06-30', autopay_enabled: false, units: { suite: '3', properties: { name: 'Raytown Flex' } } }
const data = (over: Partial<PortalHomeData> = {}): PortalHomeData => ({
  me: { tenant: { id: 't1', name: 'KC Brewing Supply', contact_email: 'x', stripe_customer_id: null, auth_user_id: 'u' }, total_balance: 18412.51 },
  charges: [], payments: [], leases: [lease] as never, aging, ...over,
})
const render = (node: ReactElement, path = '/') => renderToStaticMarkup(
  createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, { initialEntries: [path] }, node)),
)

describe('PortalHomeView: what makes up your balance', () => {
  it('states the past-due part and itemizes the aged buckets, then shows credit on account', () => {
    const html = render(createElement(PortalHomeView, { data: data() }))
    expect(html).toContain('$6,340.18 of that is past due.')
    expect(html).toContain('What makes up your balance')
    expect(html).toContain('Not yet due')
    expect(html).toContain('31–60 days past due')
    expect(html).toContain('61–90 days past due')
    expect(html).not.toContain('Over 90 days past due')
    expect(html).toContain('Credit on account')
    expect(html).toContain('-$250.00')
    expect(html).toContain('$18,412.51')
    expect(html).toContain('oldest charges first')
  })

  it('without aging (failed or loading): no breakdown and no past-due claim, balance still shown', () => {
    const html = render(createElement(PortalHomeView, { data: data({ aging: undefined }) }))
    expect(html).not.toContain('What makes up your balance')
    expect(html).not.toContain('past due.')
    expect(html).toContain('$18,412.51')
  })

  it('preview mode renders portal links as inert text', () => {
    const live = render(createElement(PortalHomeView, { data: data() }))
    const preview = render(createElement(PortalHomeView, { data: data(), preview: true }))
    expect(live).toContain('href="/portal/pay"')
    expect(preview).not.toContain('href="/portal')
    expect(preview).toContain('Link disabled in preview')
  })
})

describe('PortalDashboard', () => {
  const base = {
    'portal-me': ok({ tenant: { name: 'KC Brewing Supply' }, total_balance: 18412.51 }),
    'portal-payments': ok({ data: [] }),
    'portal-charges': ok({ data: [] }),
    'portal-lease': ok({ data: [lease] }),
  }
  it('shows the breakdown when aging loads', () => {
    results.current = { ...base, 'portal-aging': ok(aging) }
    expect(render(createElement(PortalDashboard))).toContain('What makes up your balance')
  })
  it('a failed aging read never blocks the balance or the pay path', () => {
    results.current = { ...base, 'portal-aging': failed('aging boom') }
    const html = render(createElement(PortalDashboard))
    expect(html).not.toContain('role="alert"')
    expect(html).toContain('href="/portal/pay"')
    expect(html).not.toContain('What makes up your balance')
  })
})

describe('Admin "View as tenant"', () => {
  const preview = {
    me: data().me, charges: { data: [] }, payments: { data: [] }, lease: { data: [lease] }, aging,
  }
  const page = () => render(
    createElement(Routes, null, createElement(Route, { path: '/tenants/:id/portal-preview', element: createElement(TenantPortalPreview) })),
    '/tenants/t1/portal-preview',
  )
  it('renders the shared portal home from the preview payload, in preview mode, with an exit back to the tenant', () => {
    results.current = { 'tenant-portal-preview': ok(preview) }
    const html = page()
    expect(html).toContain('Previewing <strong class="text-white">KC Brewing Supply</strong>')
    expect(html).toContain('What makes up your balance')
    expect(html).not.toContain('href="/portal')
    expect(html).toContain('href="/tenants/t1"')
  })
  it('shows the error banner when the preview fails (no partial page)', () => {
    results.current = { 'tenant-portal-preview': failed('Failed to load tenant portal preview') }
    const html = page()
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('What makes up your balance')
  })
  it('does not pull the portal API module (and its auth client) into the admin page', () => {
    const src = readFileSync(join(__dirname, '../../src/pages/tenants/TenantPortalPreview.tsx'), 'utf-8')
    expect(src).not.toMatch(/import\s+\{[^}]*\}\s+from\s+'..\/..\/portal\/lib\/portal-api'/)
    expect(src).toMatch(/import type \{[^}]*\} from '..\/..\/portal\/lib\/portal-api'/)
    const view = readFileSync(join(__dirname, '../../src/portal/components/PortalHomeView.tsx'), 'utf-8')
    expect(view).not.toMatch(/import\s+\{[^}]*\}\s+from\s+'..\/lib\/portal-api'/)
  })
})
