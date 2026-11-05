import { Link } from 'react-router'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Button } from '../../components/ui/Button'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import type { Tenant } from '../../types'

const h = dataTableColumnHelper<Tenant>()
const muted = (v: string | null) => <span className="text-muted-foreground">{v ?? '—'}</span>

// Sortable ids match the server allowlist: name, created_at.
const columns = [
  h.accessor('name', {
    header: 'Company',
    enableSorting: true,
    cell: ({ row }) => (
      <Link to={`/tenants/${row.original.id}`} className="font-medium text-foreground hover:underline">
        {row.original.name}
      </Link>
    ),
  }),
  h.accessor('contact_name', { header: 'Contact', cell: ({ row }) => muted(row.original.contact_name) }),
  h.accessor('contact_email', { header: 'Email', cell: ({ row }) => muted(row.original.contact_email) }),
  h.accessor('contact_phone', { header: 'Phone', cell: ({ row }) => muted(row.original.contact_phone) }),
]

export function TenantsList() {
  return (
    <div>
      <PageHeader
        title="Tenants"
        action={
          <Button asChild>
            <Link to="/tenants/new">+ Add Tenant</Link>
          </Button>
        }
      />
      <DataTable<Tenant>
        columns={columns}
        queryKey={['tenants', 'list']}
        fetchPage={(p) => api.list<Tenant>('/tenants', p)}
        searchPlaceholder="Search company, contact or email…"
        rowHref={(t) => `/tenants/${t.id}`}
        csvFilename={csvFilename('tenants')}
        initialSort={{ id: 'name', desc: false }}
        emptyTitle="No tenants yet"
      />
    </div>
  )
}
