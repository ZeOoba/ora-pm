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
})
