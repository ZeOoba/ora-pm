import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ReactQuery from '@tanstack/react-query'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))
const results = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof ReactQuery>()),
  useQuery: (opts: { queryKey: unknown[] }) => results.current[opts.queryKey.slice(0, 2).join(':')],
}))

import { ArPosting } from '../../src/pages/books/ArPosting'
import { AR_ROLE_LABELS, centralToday, signedDollars } from '../../src/pages/books/ar-posting-helpers'
import { AR_ROLES } from '../../server/lib/gl-ar-posting'
import { flatNavItems } from '../../src/components/nav-config'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
  createElement(MemoryRouter, null, createElement(ArPosting))))
const ENT = { data: [{ id: 'e1', name: 'Raytown Flex Holdings LLC', accounting_basis: 'accrual', qb_file_name: null }] }

describe('AR posting page', () => {
  it('lists entities; nothing else until one is chosen', () => {
    results.current = { 'gl:entities': ok(ENT), 'gl:ar': ok(undefined), 'gl:accounts': ok(undefined) }
    const html = render()
    expect(html).toContain('Raytown Flex Holdings LLC (accrual)')
    expect(html).not.toContain('Post to the ledger')
  })
  it('role labels cover exactly the server roles', () => {
    expect(AR_ROLE_LABELS.map((r) => r.role).sort()).toEqual([...AR_ROLES].sort())
  })
  it('today is the US Central calendar day', () => {
    expect(centralToday(new Date('2026-11-12T03:30:00Z'))).toBe('2026-11-11')
    expect(centralToday(new Date('2026-11-12T07:00:00Z'))).toBe('2026-11-12')
  })
  it('signed dollars', () => {
    expect(signedDollars(-169900)).toBe('−$1,699.00')
    expect(signedDollars(5)).toBe('$0.05')
  })
  it('is in the Books navigation', () => {
    expect(flatNavItems().some((i) => i.to === '/books/ar-posting' && i.label === 'AR posting')).toBe(true)
  })
})
