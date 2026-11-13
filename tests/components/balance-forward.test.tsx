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

import { BalanceForward } from '../../src/pages/books/BalanceForward'
import { agingFileProblem, parseDollarsInput } from '../../src/pages/books/balance-forward-helpers'
import { flatNavItems } from '../../src/components/nav-config'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
  createElement(MemoryRouter, null, createElement(BalanceForward))))

describe('Balance forward page', () => {
  it('lists the LLCs; the import appears once one is chosen', () => {
    results.current = { 'balance-forwards:llcs': ok({ data: [{ name: 'Example Flex, LLC', properties: 2 }] }), 'balance-forwards:list': ok(undefined) }
    const html = render()
    expect(html).toContain('Example Flex, LLC (2 properties)')
    expect(html).toContain('Balance forward from prior system')
    expect(html).not.toContain('Import from QuickBooks')
  })
  it('reads typed QuickBooks balances as signed cents', () => {
    expect(parseDollarsInput('1,234.56')).toBe(123456)
    expect(parseDollarsInput('$ 15')).toBe(1500)
    expect(parseDollarsInput('-250.5')).toBe(-25050)
    expect(parseDollarsInput('(250.50)')).toBe(-25050)
    expect(parseDollarsInput('0')).toBe(0)
    expect(parseDollarsInput('')).toBeNull()
    expect(parseDollarsInput('1.234')).toBeNull()
    expect(parseDollarsInput('abc')).toBeNull()
  })
  it('accepts only .csv files under 1 MB', () => {
    expect(agingFileProblem({ name: 'AR Aging 11-12-26.CSV', size: 5_000 })).toBeNull()
    expect(agingFileProblem({ name: 'aging.xlsx', size: 5_000 })).toMatch(/CSV/)
    expect(agingFileProblem({ name: 'aging.csv', size: 2 * 1024 * 1024 })).toMatch(/1 MB/)
  })
  it('is in the Books navigation', () => {
    expect(flatNavItems().some((i) => i.to === '/books/balance-forward' && i.label === 'Balance forward')).toBe(true)
  })
})

describe('dayBefore', () => {
  it('is the latest allowed cut-off (before today), across month and year ends', async () => {
    const { dayBefore } = await import('../../src/pages/books/balance-forward-helpers')
    expect(dayBefore('2026-11-13')).toBe('2026-11-12')
    expect(dayBefore('2027-01-01')).toBe('2026-12-31')
    expect(dayBefore('2028-03-01')).toBe('2028-02-29')
  })
})
