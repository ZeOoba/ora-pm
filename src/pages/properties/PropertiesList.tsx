import { Link } from 'react-router'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Button } from '../../components/ui/Button'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { formatSF } from '../../lib/format'
import type { Property } from '../../types'

const h = dataTableColumnHelper<Property>()

// Sortable ids match the server allowlist: name, city, state, created_at.
const columns = [
  h.accessor('name', {
    header: 'Name',
    enableSorting: true,
    cell: ({ row }) => (
      <Link to={`/properties/${row.original.id}`} className="font-medium text-foreground hover:underline">
        {row.original.name}
      </Link>
    ),
  }),
  h.accessor('address', { header: 'Address', cell: ({ row }) => row.original.address }),
  h.accessor('city', { header: 'City', enableSorting: true, cell: ({ row }) => row.original.city }),
  h.accessor('state', { header: 'State', enableSorting: true, cell: ({ row }) => row.original.state }),
  h.accessor('property_type', {
    header: 'Type',
    cell: ({ row }) => <span className="capitalize text-muted-foreground">{row.original.property_type}</span>,
  }),
  h.accessor('total_sf', {
    header: 'SF',
    meta: { numeric: true },
    cell: ({ row }) => formatSF(row.original.total_sf),
  }),
  h.accessor('entity_llc', {
    header: 'Entity LLC',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.entity_llc ?? '—'}</span>,
  }),
]

export function PropertiesList() {
  return (
    <div>
      <PageHeader
        title="Properties"
        action={
          <Button asChild>
            <Link to="/properties/new">+ Add Property</Link>
          </Button>
        }
      />
      <DataTable<Property>
        columns={columns}
        queryKey={['properties', 'list']}
        fetchPage={(p) => api.list<Property>('/properties', p)}
        searchPlaceholder="Search name, city or entity…"
        rowHref={(p) => `/properties/${p.id}`}
        csvFilename={csvFilename('properties')}
        initialSort={{ id: 'name', desc: false }}
        emptyTitle="No properties yet"
      />
    </div>
  )
}
