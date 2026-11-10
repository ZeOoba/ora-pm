import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { formatCurrency, formatSF, formatPSF, formatDate } from '../../lib/format'
import { StatusBadge } from '../../components/StatusBadge'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { QueryState } from '../../components/QueryState'
import { EmptyState } from '../../components/ui/EmptyState'
import { ViewToggle } from '../../components/ViewToggle'
import { useView } from '../../components/view-param'
import { RentRollGrouped } from '../money/RentRollGrouped'
import type { RentRollRow } from '../../types'

const h = dataTableColumnHelper<RentRollRow>()
const money = (v: number | null) => (v != null ? formatCurrency(v) : '—')

// Client mode: /reports/rent-roll is unpaged, so every column sorts in memory.
const columns = [
  h.accessor('property_name', {
    header: 'Property',
    enableSorting: true,
    cell: ({ row }) => <span className="font-medium text-foreground">{row.original.property_name}</span>,
  }),
  h.accessor('suite', { header: 'Suite', enableSorting: true, cell: ({ row }) => row.original.suite }),
  h.accessor('sf', {
    header: 'SF',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => (row.original.sf ? formatSF(row.original.sf) : '—'),
  }),
  h.accessor('tenant_name', {
    header: 'Tenant',
    enableSorting: true,
    meta: { csv: (r: RentRollRow) => r.tenant_name ?? 'Vacant' },
    cell: ({ row }) =>
      row.original.tenant_name ?? <span className="italic text-muted-foreground">Vacant</span>,
  }),
  h.accessor('end_date', {
    header: 'Lease End',
    enableSorting: true,
    cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.end_date)}</span>,
  }),
  h.accessor('base_rent_monthly', {
    header: 'Base Rent',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => money(row.original.base_rent_monthly),
  }),
  h.accessor('cam_estimate_monthly', {
    header: 'CAM',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => money(row.original.cam_estimate_monthly),
  }),
  h.accessor('total_monthly', {
    header: 'Total/mo',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => <span className="font-medium">{money(row.original.total_monthly)}</span>,
  }),
  h.accessor('rent_psf_annual', {
    header: '$/SF/yr',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => (row.original.rent_psf_annual != null ? formatPSF(row.original.rent_psf_annual) : '—'),
  }),
  h.accessor((r) => r.lease_status ?? r.unit_status, {
    id: 'status',
    header: 'Status',
    enableSorting: true,
    cell: ({ row }) => <StatusBadge status={row.original.lease_status ?? row.original.unit_status} />,
  }),
]

function matchesSearch(r: RentRollRow, q: string): boolean {
  const needle = q.toLowerCase()
  return [r.property_name, r.suite, r.tenant_name].some((v) => v?.toLowerCase().includes(needle))
}

const VIEWS = ['grouped', 'table'] as const

export function RentRoll() {
  const query = useQuery({
    queryKey: ['rent-roll'],
    queryFn: () => api.get<{ data: RentRollRow[] }>('/reports/rent-roll').then((r) => r.data),
  })
  const { data, error, refetch } = query
  const [view, setView] = useView(VIEWS)

  const all = data ?? []
  const totalMonthly = all.reduce((s, r) => s + (r.total_monthly ?? 0), 0)
  const occupied = all.filter((r) => r.lease_status === 'active').length
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div>
      <PageHeader
        title="Rent Roll"
        subtitle={data ? `As of ${formatDate(today)} · ${occupied} occupied · ${formatCurrency(totalMonthly)}/mo total` : undefined}
        action={<ViewToggle options={VIEWS} value={view} onChange={setView} labels={{ grouped: 'By property', table: 'Table & export' }} />}
      />
      {view === 'grouped' ? (
        <QueryState query={query} isEmpty={() => all.length === 0} empty={<EmptyState title="No units" message="Add properties and units to build the rent roll." />}>
          <RentRollGrouped rows={all} today={today} />
        </QueryState>
      ) : (
      <DataTable<RentRollRow>
        mode="client"
        columns={columns}
        queryKey={['rent-roll', 'table']}
        rows={data}
        error={error}
        onRetry={() => void refetch()}
        getRowId={(r) => r.unit_id}
        clientSearchFn={matchesSearch}
        searchPlaceholder="Search property, suite or tenant…"
        csvFilename={csvFilename('rent-roll')}
        initialSort={{ id: 'property_name', desc: false }}
        emptyTitle="No data"
      />
      )}
    </div>
  )
}
