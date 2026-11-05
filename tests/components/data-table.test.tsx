import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { pageSizeOptions } from '../../src/components/data-table/table-state'
import { DataTablePager } from '../../src/components/data-table/DataTablePager'
import { DataTable, type DataTableProps } from '../../src/components/data-table/DataTable'
import { dataTableColumnHelper, buildCsvColumns } from '../../src/components/data-table/columns'

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

describe('sorting is opt-in', () => {
  it('renders a sort button only for columns with enableSorting: true', () => {
    const html = render()
    const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
    expect((head.match(/<button/g) ?? []).length).toBe(1)
    expect(head).toMatch(/<button[^>]*>.*Tenant/s)
  })
})

describe('DataTablePager', () => {
  const pager = (props: Partial<Parameters<typeof DataTablePager>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(DataTablePager, {
        pageIndex: 0, pageSize: 25, total: 0, onPageChange: () => {}, onPageSizeChange: () => {}, ...props,
      }),
    )
  it('hides the range label when errored with no data', () => {
    expect(pager({ hideRange: true })).not.toContain('Showing')
    expect(pager()).toContain('Showing 0 of 0')
  })
  it('includes a non-standard page size as an option', () => {
    expect(pageSizeOptions(10)).toEqual([10, 25, 50, 100])
    expect(pageSizeOptions(50)).toEqual([25, 50, 100])
  })
})

describe('buildCsvColumns', () => {
  type Acc = (r: unknown, i: number) => unknown
  it('skips display columns, honors meta.csv and accessors', () => {
    const cols = buildCsvColumns<Record<string, unknown>>([
      { id: 'name', columnDef: { header: 'name' }, accessorFn: ((r: Record<string, unknown>) => r.name) as Acc },
      { id: 'actions', columnDef: { header: 'actions' } },
      { id: 'rent', columnDef: { header: 'rent', meta: { csv: (r: { rent: number }) => `$${r.rent}` } } },
    ])
    expect(cols.map((c) => c.header)).toEqual(['name', 'rent'])
    expect(cols[0].accessor({ name: 'A' })).toBe('A')
    expect(cols[1].accessor({ rent: 5 })).toBe('$5')
  })
  it('uses meta.csvHeader for non-string headers', () => {
    const cols = buildCsvColumns([{ id: 'x', columnDef: { header: () => null, meta: { csvHeader: 'X!', csv: () => 1 } } }])
    expect(cols[0].header).toBe('X!')
  })
})
