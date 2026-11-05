import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataTable, type DataTableProps } from '../../src/components/data-table/DataTable'
import { dataTableColumnHelper } from '../../src/components/data-table/columns'

type Row = { id: string; name: string; rent: number }
const h = dataTableColumnHelper<Row>()
const columns = [
  h.accessor('name', { header: 'Tenant', enableSorting: true }),
  h.accessor('rent', { header: 'Rent', meta: { numeric: true } }),
]

function render(props: Partial<DataTableProps<Row>> = {}) {
  const qc = new QueryClient()
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(DataTable<Row>, {
        columns,
        queryKey: ['test-rows'],
        fetchPage: () => new Promise<{ data: Row[]; total: number }>(() => {}),
        searchPlaceholder: 'Search tenants',
        ...props,
      }),
    ),
  )
}

describe('DataTable (initial render = loading state)', () => {
  it('renders skeleton rows while loading', () => {
    const html = render()
    expect((html.match(/data-slot="skeleton"/g) ?? []).length).toBeGreaterThanOrEqual(5)
    expect(html).toContain('Tenant')
    expect(html).toContain('Rent')
  })

  it('renders the search box with the placeholder', () => {
    expect(render()).toContain('placeholder="Search tenants"')
  })

  it('does not render the empty state or error banner while loading', () => {
    const html = render()
    expect(html).not.toContain('Retry')
    expect(html).not.toContain('No results')
  })

  it('renders a select-all checkbox column only when bulkActions is given', () => {
    expect(render()).not.toContain('aria-label="Select all rows"')
    expect(render({ bulkActions: () => null })).toContain('aria-label="Select all rows"')
  })

  it('renders the Export CSV control only when csvFilename is given', () => {
    expect(render()).not.toContain('Export CSV')
    expect(render({ csvFilename: 'tenants' })).toContain('Export CSV')
  })

  it('wraps the table in a horizontally scrollable container', () => {
    expect(render()).toContain('overflow-x-auto')
  })
})
