import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { DataTable, type FilterDef } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { formatSF } from '../../lib/format'
import type { Property, Unit } from '../../types'

const h = dataTableColumnHelper<Unit>()

// Sortable ids match the server allowlist: suite, sf, status.
function buildColumns(propertyNames: Map<string, string>) {
  return [
    h.accessor((u) => propertyNames.get(u.property_id) ?? '', {
      id: 'property',
      header: 'Property',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{propertyNames.get(row.original.property_id) ?? '—'}</span>
      ),
    }),
    h.accessor('suite', {
      header: 'Suite',
      enableSorting: true,
      cell: ({ row }) => <span className="font-medium text-foreground">{row.original.suite}</span>,
    }),
    h.accessor('floor', {
      header: 'Floor',
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.floor ?? '—'}</span>,
    }),
    h.accessor('sf', {
      header: 'SF',
      enableSorting: true,
      meta: { numeric: true },
      cell: ({ row }) => formatSF(row.original.sf),
    }),
    h.accessor('status', {
      header: 'Status',
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    }),
  ]
}

export function UnitsPage() {
  // Properties feed both the filter dropdown and the Property column.
  const { data: properties } = useQuery({
    queryKey: ['properties', 'picker'],
    queryFn: () => api.list<Property>('/properties', { limit: 200, sort: 'name', dir: 'asc' }).then((r) => r.data),
  })

  const propertyNames = useMemo(() => new Map((properties ?? []).map((p) => [p.id, p.name])), [properties])
  const columns = useMemo(() => buildColumns(propertyNames), [propertyNames])
  const filters = useMemo<FilterDef[]>(
    () => [
      {
        id: 'property_id',
        label: 'Property',
        options: (properties ?? []).map((p) => ({ value: p.id, label: p.name })),
      },
    ],
    [properties],
  )

  return (
    <div>
      <PageHeader title="Unit Matrix" />
      <DataTable<Unit>
        columns={columns}
        queryKey={['units', 'list']}
        // /units is unpaged unless limit/offset are passed; DataTable always passes them.
        fetchPage={(p) => api.list<Unit>('/units', p)}
        searchable={false}
        filters={filters}
        csvFilename={csvFilename('units')}
        initialSort={{ id: 'suite', desc: false }}
        emptyTitle="No units"
      />
    </div>
  )
}
