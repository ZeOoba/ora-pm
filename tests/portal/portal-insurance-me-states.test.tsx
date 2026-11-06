import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/portal/lib/supabase-portal', () => ({
  portalSupabase: { auth: { getSession: vi.fn() }, storage: {} },
}))
vi.mock('../../src/portal/lib/portal-api', () => ({ portalApi: { getMe: vi.fn() } }))

const result = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: () => result.current,
}))

import { PortalInsurance } from '../../src/portal/pages/PortalInsurance'
const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PortalInsurance)))
const base = { isPending: false, isLoading: false, isError: false, error: null, data: undefined, refetch: vi.fn() }

describe('<PortalInsurance> portal-me states', () => {
  it('shows a compact loading line while the profile loads', () => {
    result.current = { ...base, isPending: true, isLoading: true }
    const html = render()
    expect(html).toContain('Loading your account…')
    expect(html).toContain('Loading account…')
  })
  it('labels the disabled submit "Unavailable" after a first-load error', () => {
    result.current = { ...base, isError: true, error: new Error('me boom') }
    const html = render()
    expect(html).toContain('Unavailable')
    expect(html).not.toContain('Loading account…')
    expect(html).toContain('disabled')
  })
})
