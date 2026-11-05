import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ComponentType } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: { auth: { getSession: vi.fn(), mfa: {} }, storage: {} },
}))
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn().mockResolvedValue(null) }))

// Mocked useQuery results keyed by the first queryKey segment.
const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { PortalDashboard } from '../../src/portal/pages/PortalDashboard'
import { PortalDocuments } from '../../src/portal/pages/PortalDocuments'
import { PortalMyLease } from '../../src/portal/pages/PortalMyLease'
import { PortalPaymentHistory } from '../../src/portal/pages/PortalPaymentHistory'
import { PortalPayNow } from '../../src/portal/pages/PortalPayNow'
import { PortalAccount } from '../../src/portal/pages/PortalAccount'
import { PortalInsurance } from '../../src/portal/pages/PortalInsurance'

const pending = () => ({ isPending: true, isLoading: true, isError: false, error: null, data: undefined, refetch: vi.fn() })
const failed = (msg: string) => ({ isPending: false, isLoading: false, isError: true, error: new Error(msg), data: undefined, refetch: vi.fn() })

function render(Page: ComponentType) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(MemoryRouter, null, createElement(Page)),
    ),
  )
}

const KEYS = ['portal-me', 'portal-payments', 'portal-charges', 'portal-documents', 'portal-lease']
const allWith = (make: () => unknown) => Object.fromEntries(KEYS.map((k) => [k, make()]))

const PAGES: [string, ComponentType][] = [
  ['PortalDashboard', PortalDashboard],
  ['PortalDocuments', PortalDocuments],
  ['PortalMyLease', PortalMyLease],
  ['PortalPaymentHistory', PortalPaymentHistory],
  ['PortalPayNow', PortalPayNow],
  ['PortalAccount', PortalAccount],
  ['PortalInsurance', PortalInsurance],
]

describe('portal pages: loading skeleton and error state', () => {
  it.each(PAGES)('%s renders a skeleton while its queries load', (_name, Page) => {
    results.current = allWith(pending)
    expect(render(Page)).toContain('aria-busy="true"')
  })

  it.each(PAGES)('%s renders an alert (not an empty/zero state) when its queries fail', (_name, Page) => {
    results.current = allWith(() => failed('portal boom'))
    const html = render(Page)
    expect(html).toContain('role="alert"')
    expect(html).toContain('portal boom')
    expect(html).not.toContain('all caught up')
    expect(html).not.toContain('No payments on record')
  })

  it('PortalAccount: a failed profile read does not hide the autopay card (and vice versa)', () => {
    const lease = { id: 'l1', autopay_enabled: false, autopay_payment_method_id: 'pm_1', units: { suite: '101', properties: { name: 'Acme Test Park' } } }
    results.current = { 'portal-me': failed('me boom'), 'portal-lease': { isPending: false, isLoading: false, isError: false, error: null, data: { data: [lease] }, refetch: vi.fn() } }
    let html = render(PortalAccount)
    expect(html).toContain('me boom')
    expect(html).toContain('Autopay OFF')
    results.current = { 'portal-me': { isPending: false, isLoading: false, isError: false, error: null, data: { tenant: { name: 'Acme Test LLC' } }, refetch: vi.fn() }, 'portal-lease': failed('lease boom') }
    html = render(PortalAccount)
    expect(html).toContain('Acme Test LLC')
    expect(html).toContain('lease boom')
  })

  it('PortalAccount: a failed refetch after data loaded keeps the autopay card', () => {
    const lease = { id: 'l1', autopay_enabled: true, autopay_payment_method_id: 'pm_1', units: { suite: '101', properties: { name: 'Acme Test Park' } } }
    const stale = (data: unknown) => ({ isPending: false, isLoading: false, isError: true, error: new Error('refetch boom'), data, refetch: vi.fn() })
    results.current = { 'portal-me': stale({ tenant: { name: 'Acme Test LLC' } }), 'portal-lease': stale({ data: [lease] }) }
    const html = render(PortalAccount)
    expect(html).toContain('Autopay ON')
    expect(html).toContain('showing last loaded data')
  })

  it('PortalInsurance: form stays rendered once portal-me loaded, even if a refetch failed', () => {
    const stale = { isPending: false, isLoading: false, isError: true, error: new Error('refetch boom'), data: { tenant: { id: 't1' } }, refetch: vi.fn() }
    results.current = { 'portal-me': stale }
    const html = render(PortalInsurance)
    expect(html).toContain('Submit Certificate')
    expect(html).toContain('showing last loaded data')
  })
})
