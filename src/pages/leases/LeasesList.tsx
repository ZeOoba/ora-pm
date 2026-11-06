import { Link } from 'react-router'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { DataTable, type FilterDef } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { formatCurrency, formatDate } from '../../lib/format'
import type { Lease, Tenant, Unit, Property } from '../../types'

type LeaseRow = Lease & {
  tenants: Pick<Tenant, 'name'>
  units: Pick<Unit, 'suite' | 'sf'> & { properties: Pick<Property, 'name'> }
}

const h = dataTableColumnHelper<LeaseRow>()
const muted = (v: string | null | undefined) => <span className="text-muted-foreground">{v ?? '—'}</span>

// Sortable ids match the server allowlist: start_date, end_date, base_rent_monthly, status.
// Tenant / Property / Suite are joined columns the server cannot sort by.
const columns = [
  h.accessor((l) => l.tenants?.name, {
    id: 'tenant',
    header: 'Tenant',
    cell: ({ row }) => (
      <Link to={`/leases/${row.original.id}`} className="font-medium text-foreground hover:underline">
        {row.original.tenants?.name ?? '—'}
      </Link>
    ),
  }),
  h.accessor((l) => l.units?.properties?.name, {
    id: 'property',
    header: 'Property',
    cell: ({ row }) => muted(row.original.units?.properties?.name),
  }),
  h.accessor((l) => l.units?.suite, {
    id: 'suite',
    header: 'Suite',
    cell: ({ row }) => muted(row.original.units?.suite),
  }),
  h.accessor('end_date', {
    header: 'End Date',
    enableSorting: true,
    cell: ({ row }) => muted(formatDate(row.original.end_date)),
  }),
  h.accessor('base_rent_monthly', {
    header: 'Rent/mo',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => formatCurrency(row.original.base_rent_monthly),
  }),
  h.accessor('status', {
    header: 'Status',
    enableSorting: true,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  }),
]

// leases.status CHECK (migration 0001): active | expired | terminated | pending.
// "All" sends no status param (the endpoint then returns every status).
const FILTERS: FilterDef[] = [
  {
    id: 'status',
    label: 'Status',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'pending', label: 'Pending' },
      { value: 'expired', label: 'Expired' },
      { value: 'terminated', label: 'Terminated' },
    ],
  },
]

export function LeasesList() {
  return (
    <div>
      <PageHeader
        title="Leases"
        action={
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" className="border border-border">
              <Link to="/leases/intake">Upload lease</Link>
            </Button>
            <Button asChild>
              <Link to="/leases/new">+ Add Lease</Link>
            </Button>
          </div>
        }
      />
      <DataTable<LeaseRow>
        columns={columns}
        queryKey={['leases', 'list']}
        fetchPage={(p) => api.list<LeaseRow>('/leases', p)}
        searchable={false}
        filters={FILTERS}
        rowHref={(l) => `/leases/${l.id}`}
        csvFilename={csvFilename('leases')}
        initialSort={{ id: 'end_date', desc: false }}
        emptyTitle="No leases"
      />
    </div>
  )
}
