import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: { auth: { getSession: vi.fn(), mfa: {} }, storage: {} },
}))
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn().mockResolvedValue(null) }))

const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[String(opts.queryKey[0])],
}))

import { PortalPayNow } from '../../src/portal/pages/PortalPayNow'
import { chargesGate } from '../../src/portal/lib/charges'

const charge = { id: 'c1', lease_id: 'l1', type: 'rent', description: 'Acme Test rent', due_date: '2026-11-01', amount: 100 }
const q = (over: Record<string, unknown>) => ({ isPending: false, isLoading: false, isError: false, error: null, data: undefined, refetch: vi.fn(), ...over })
const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, createElement(PortalPayNow))))

describe('chargesGate (what may hide the pay flow)', () => {
  it('blocks on first load and on first-load failure at step select', () => {
    expect(chargesGate('select', { isLoading: true, isError: false, data: undefined })).toBe('blocking')
    expect(chargesGate('select', { isLoading: false, isError: true, data: undefined })).toBe('blocking')
  })
  it('does not block when a background refetch failed but data is kept', () => {
    expect(chargesGate('select', { isLoading: false, isError: true, data: { data: [charge] } })).toBe('content')
  })
  it.each(['processing', 'done', 'error'] as const)('never blocks step %s whatever the charges query state', (step) => {
    expect(chargesGate(step, { isLoading: true, isError: true, data: undefined })).toBe('content')
    expect(chargesGate(step, { isLoading: false, isError: true, data: undefined })).toBe('content')
  })
})

describe('<PortalPayNow> with a failed background refetch', () => {
  it('still renders the charges list (plus a non-blocking warning) when isError but data is kept', () => {
    results.current = {
      'portal-me': q({ data: { tenant: { id: 't1', name: 'Acme Test LLC' } } }),
      'portal-charges': q({ isError: true, error: new Error('refetch boom'), data: { data: [charge] } }),
    }
    const html = render()
    expect(html).toContain('Open Charges')
    expect(html).toContain('Acme Test rent')
    expect(html).toContain('showing last loaded data')
    expect(html).not.toContain('role="alert"')
  })
})
