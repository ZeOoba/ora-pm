import { Link } from 'react-router'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { formatDate, formatCurrency } from '../../lib/format'
import type { InsuranceCertificate, Tenant } from '../../types'

type CertRow = InsuranceCertificate & { tenants: Pick<Tenant, 'name'> }

const h = dataTableColumnHelper<CertRow>()
const muted = (v: string | null | undefined) => <span className="text-muted-foreground">{v ?? '—'}</span>

// Sortable ids match the server allowlist: expiration_date, status.
const columns = [
  h.accessor((c) => c.tenants?.name, {
    id: 'tenant',
    header: 'Tenant',
    cell: ({ row }) => <span className="font-medium text-foreground">{row.original.tenants?.name ?? '—'}</span>,
  }),
  h.accessor('policy_type', {
    header: 'Policy Type',
    cell: ({ row }) => <span className="capitalize text-muted-foreground">{row.original.policy_type.replace(/_/g, ' ')}</span>,
  }),
  h.accessor('carrier', { header: 'Carrier', cell: ({ row }) => muted(row.original.carrier) }),
  h.accessor('coverage_amount', {
    header: 'Coverage',
    meta: { numeric: true },
    cell: ({ row }) => formatCurrency(row.original.coverage_amount),
  }),
  h.accessor('expiration_date', {
    header: 'Expiration',
    enableSorting: true,
    cell: ({ row }) => formatDate(row.original.expiration_date),
  }),
  h.accessor('status', {
    header: 'Status',
    enableSorting: true,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  }),
]

export function InsuranceList() {
  return (
    <div>
      <PageHeader
        title="Insurance Certificates"
        action={
          <Button asChild>
            <Link to="/insurance/new">+ Add Certificate</Link>
          </Button>
        }
      />
      <DataTable<CertRow>
        columns={columns}
        queryKey={['insurance', 'list']}
        // /insurance is unpaged unless limit/offset are passed; DataTable always passes them.
        fetchPage={(p) => api.list<CertRow>('/insurance', p)}
        searchable={false}
        csvFilename={csvFilename('insurance')}
        initialSort={{ id: 'expiration_date', desc: false }}
        emptyTitle="No certificates on file"
      />
    </div>
  )
}
