import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { formatDate } from '../../lib/format'
import type { Renewal } from '../../types'
import { RenewalStatusSelect } from './RenewalStatusSelect'

type RenewalRow = Renewal & {
  leases: {
    tenants: { name: string }
    units: { suite: string; properties: { name: string } }
  }
}

const h = dataTableColumnHelper<RenewalRow>()

const propertySuite = (r: RenewalRow) =>
  `${r.leases?.units?.properties?.name ?? '—'} · ${r.leases?.units?.suite ?? '—'}`

// Sortable ids match the server allowlist: expiration_date, target_decision_date, status.
const columns = [
  h.accessor((r) => r.leases?.tenants?.name, {
    id: 'tenant',
    header: 'Tenant',
    cell: ({ row }) => <span className="font-medium text-foreground">{row.original.leases?.tenants?.name ?? '—'}</span>,
  }),
  h.accessor(propertySuite, {
    id: 'property_suite',
    header: 'Property / Suite',
    cell: ({ row }) => <span className="text-muted-foreground">{propertySuite(row.original)}</span>,
  }),
  h.accessor('expiration_date', {
    header: 'Expiration',
    enableSorting: true,
    cell: ({ row }) => formatDate(row.original.expiration_date),
  }),
  h.accessor('target_decision_date', {
    header: 'Decision By',
    enableSorting: true,
    cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.target_decision_date)}</span>,
  }),
  h.accessor('status', {
    header: 'Status',
    enableSorting: true,
    // Inline edit via PUT /api/renewals/:id (status only); CSV export still reads the raw status value.
    cell: ({ row }) => <RenewalStatusSelect id={row.original.id} status={row.original.status} tenantName={row.original.leases?.tenants?.name} />,
  }),
]

export function RenewalsPipeline() {
  return (
    <div>
      <PageHeader title="Renewals" />
      <DataTable<RenewalRow>
        columns={columns}
        queryKey={['renewals', 'list']}
        // /renewals is unpaged unless limit/offset are passed; DataTable always passes them.
        fetchPage={(p) => api.list<RenewalRow>('/renewals', p)}
        searchable={false}
        rowHref={(r) => `/leases/${r.lease_id}`}
        csvFilename={csvFilename('renewals')}
        initialSort={{ id: 'expiration_date', desc: false }}
        emptyTitle="No renewals tracked"
      />
    </div>
  )
}
