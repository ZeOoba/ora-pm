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

import { OpeningBalances } from '../../src/pages/books/OpeningBalances'
import { DEFAULT_START_MONTH, dollars, tbFileProblem } from '../../src/pages/books/opening-balance-helpers'
import { flatNavItems } from '../../src/components/nav-config'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
  createElement(MemoryRouter, null, createElement(OpeningBalances))))

describe('Opening balances page', () => {
  it('lists entities; nothing else until one is chosen', () => {
    results.current = { 'gl:entities': ok({ data: [{ id: 'e1', name: 'Raytown Flex Holdings LLC', accounting_basis: 'accrual', qb_file_name: null }] }), 'gl:opening-balance': ok(undefined), 'gl:accounts': ok(undefined) }
    const html = render()
    expect(html).toContain('Raytown Flex Holdings LLC (accrual)')
    expect(html).not.toContain('Import from a QuickBooks trial balance')
  })
  it('defaults the start month to the ratified January 2027', () => {
    expect(DEFAULT_START_MONTH).toBe('2027-01')
  })
  it('formats cents as dollars', () => {
    expect(dollars(12500000)).toBe('$125,000.00')
    expect(dollars(1)).toBe('$0.01')
  })
  it('accepts only .csv files under 2 MB', () => {
    expect(tbFileProblem({ name: 'Raytown TB 12-31-26.CSV', size: 20_000 })).toBeNull()
    expect(tbFileProblem({ name: 'tb.xlsx', size: 20_000 })).toMatch(/CSV/)
    expect(tbFileProblem({ name: 'tb.csv', size: 3 * 1024 * 1024 })).toMatch(/2 MB/)
  })
  it('is in the Books navigation', () => {
    expect(flatNavItems().some((i) => i.to === '/books/opening-balances' && i.label === 'Opening balances')).toBe(true)
  })
})
