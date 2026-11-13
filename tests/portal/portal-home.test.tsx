import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: { auth: { getSession: vi.fn(), signOut: vi.fn(), mfa: {} }, storage: {} },
}))

const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { PortalDashboard } from '../../src/portal/pages/PortalDashboard'
import { PortalShell } from '../../src/portal/components/PortalShell'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })

const lease = { id: 'l1', end_date: '2027-06-30', autopay_enabled: false, units: { suite: '3', properties: { name: 'Raytown Flex' } } }
const charges = [
  { id: 'c1', lease_id: 'l1', type: 'cam_estimate', description: null, due_date: '2026-11-01', amount: 3170.09 },
  { id: 'c2', lease_id: 'l1', type: 'rent', description: 'Base rent, Nov', due_date: '2026-11-01', amount: 20192.5 },
]
function data(balance: number) {
  return {
    'portal-me': ok({ tenant: { name: 'KC Brewing Supply' }, total_balance: balance }),
    'portal-payments': ok({ data: [{ id: 'p1', amount: 20192.5, payment_date: '2026-10-28', stripe_status: 'succeeded' }] }),
    'portal-charges': ok({ data: charges }),
    'portal-lease': ok({ data: [lease] }),
  }
}
const render = (node: React.ReactElement) => renderToStaticMarkup(
  createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, { initialEntries: ['/portal'] }, node)),
)

describe('Portal home', () => {
  it('says how much of the balance was carried forward from the prior system (0030), or nothing when none', () => {
    results.current = { ...data(18412.51), 'portal-me': ok({ tenant: { name: 'KC Brewing Supply' }, total_balance: 18412.51, balance_forward: { amount: -250, as_of: '2026-11-12' } }) }
    const html = render(createElement(PortalDashboard))
    expect(html).toMatch(/Includes a credit of \$250\.00 carried forward from our previous accounting system as of/)
    results.current = data(18412.51)
    expect(render(createElement(PortalDashboard))).not.toContain('carried forward')
  })

  it('leads with the balance and routes payment through the existing Pay Now page', () => {
    results.current = data(18412.51)
    const html = render(createElement(PortalDashboard))
    expect(html).toContain('You owe <span class="text-status-danger">$18,412.51</span>.')
    expect(html).toContain('href="/portal/pay"')
    expect(html).toContain('>Pay now<')
    expect(html).toContain('3–5 business days')
    expect(html).toContain('Raytown Flex · Suite 3')
  })

  it('labels charges as recent (not open), using the description or the real type column', () => {
    results.current = data(100)
    const html = render(createElement(PortalDashboard))
    expect(html).toContain('Recent charges')
    expect(html).not.toContain('Open Charges')
    expect(html).toContain('cam estimate')
    expect(html).toContain('Base rent, Nov')
  })

  it('no balance: no pay button; a credit is stated as a credit', () => {
    results.current = data(0)
    let html = render(createElement(PortalDashboard))
    expect(html).toContain('You have no balance due.')
    expect(html).not.toContain('href="/portal/pay"')
    results.current = data(-250)
    html = render(createElement(PortalDashboard))
    expect(html).toContain('credit of')
    expect(html).toContain('$250.00')
  })

  it('shows autopay state from the lease and links to manage it', () => {
    results.current = data(10)
    expect(render(createElement(PortalDashboard))).toContain('Autopay is off')
    results.current = { ...data(10), 'portal-lease': ok({ data: [{ ...lease, autopay_enabled: true }] }) }
    expect(render(createElement(PortalDashboard))).toContain('Autopay is on')
  })

  it('never imports the Stripe client or creates a payment itself', () => {
    const src = readFileSync(join(__dirname, '../../src/portal/pages/PortalDashboard.tsx'), 'utf-8')
    expect(src).not.toMatch(/createPaymentIntent|@stripe\//)
  })
})

describe('Portal shell', () => {
  it('renders the tab row with the current page marked, and sign out', () => {
    const session = { user: { email: 'ap@example.test' } } as never
    const html = render(createElement(PortalShell, { session, children: createElement('p', null, 'BODY') }))
    expect(html).toContain('aria-label="Portal"')
    expect(html).toMatch(/aria-current="page"[^>]*>Home</)
    expect(html).toContain('Sign out')
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('BODY')
  })
})
