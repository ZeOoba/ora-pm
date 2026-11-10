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

import { ChartOfAccounts } from '../../src/pages/books/ChartOfAccounts'
import { decodeIif, iifFileProblem } from '../../src/pages/books/iif-file'
import { flatNavItems } from '../../src/components/nav-config'

const ok = (data: unknown) => ({ isPending: false, isLoading: false, isError: false, error: null, data, refetch: vi.fn() })
const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
  createElement(MemoryRouter, null, createElement(ChartOfAccounts))))

describe('Chart of accounts page', () => {
  it('lists ledger entities with their basis; offers to add one', () => {
    results.current = { 'gl:entities': ok({ data: [{ id: 'e1', name: 'Raytown Flex Holdings LLC', accounting_basis: 'accrual', qb_file_name: 'Raytown.QBW' }] }), 'gl:accounts': ok(undefined) }
    const html = render()
    expect(html).toContain('Raytown Flex Holdings LLC (accrual)')
    expect(html).toContain('Add an entity')
    expect(html).not.toContain('Import from QuickBooks Desktop') // no entity chosen yet
  })

  it('with no entities, the add-entity form starts open', () => {
    results.current = { 'gl:entities': ok({ data: [] }), 'gl:accounts': ok(undefined) }
    expect(render()).toMatch(/<details open=""/)
  })

  it('is in the Books navigation', () => {
    expect(flatNavItems().some((i) => i.to === '/books/chart-of-accounts' && i.label === 'Chart of accounts')).toBe(true)
  })
})

describe('IIF file reading', () => {
  it('keeps Windows-1252 names exactly as QuickBooks wrote them', () => {
    // "Café" in Windows-1252: é = 0xE9 (invalid as UTF-8)
    const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]).buffer
    expect(decodeIif(bytes)).toBe('Café')
  })
  it('reads UTF-8 files as UTF-8', () => {
    expect(decodeIif(new TextEncoder().encode('Café').buffer as ArrayBuffer)).toBe('Café')
  })
  it('accepts .iif (any case) and .txt; rejects other files and oversized ones', () => {
    expect(iifFileProblem({ name: 'Raytown COA.IIF', size: 10_000 })).toBeNull()
    expect(iifFileProblem({ name: 'coa.txt', size: 10_000 })).toBeNull()
    expect(iifFileProblem({ name: 'coa.xlsx', size: 10_000 })).toMatch(/IIF/)
    expect(iifFileProblem({ name: 'coa.iif', size: 3 * 1024 * 1024 })).toMatch(/larger than 2 MB/)
  })
})
