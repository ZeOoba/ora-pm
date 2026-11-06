import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Badge, StatusBadge } from '../../components/ui/Badge'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { cn } from '@/lib/utils'
import { formatCurrency, formatDate } from '../../lib/format'
import type { Charge } from '../../types'

const CHARGE_LABELS: Record<string, string> = {
  rent: 'Rent',
  cam_estimate: 'CAM Estimate',
  cam_true_up: 'CAM True-Up',
  late_fee: 'Late Fee',
  security_deposit: 'Security Deposit',
  utility_water: 'Water',
  utility_gas: 'Gas',
  utility_electric: 'Electric',
  utility_other: 'Utility (Other)',
  percentage_rent: 'Percentage Rent',
  other: 'Other',
}

const h = dataTableColumnHelper<Charge>()

// OI-278 / migration 0016: voided rows stay in the list as the audit trail but are
// visibly retired — struck-through amount + "Voided" badge carrying the reason.
// Sortable ids match the server allowlist: charge_date, amount, type.
const columns = [
  h.accessor('charge_date', {
    header: 'Charge Date',
    enableSorting: true,
    cell: ({ row: { original: ch } }) => (
      <span className={cn(ch.voided_at && 'text-muted-foreground')}>{formatDate(ch.charge_date)}</span>
    ),
  }),
  h.accessor('due_date', {
    header: 'Due Date',
    cell: ({ row: { original: ch } }) => <span className="text-muted-foreground">{formatDate(ch.due_date)}</span>,
  }),
  h.accessor('type', {
    header: 'Type',
    enableSorting: true,
    meta: {
      csv: (ch: Charge) => {
        const label = CHARGE_LABELS[ch.type] ?? ch.type
        return ch.voided_at ? `${label} (VOIDED)` : label
      },
    },
    cell: ({ row: { original: ch } }) => (
      <span className={cn(ch.voided_at && 'text-muted-foreground')}>
        {CHARGE_LABELS[ch.type] ?? ch.type}
        {ch.voided_at && (
          <span className="ml-2" title={`${ch.void_reason ?? ''} (${formatDate(ch.voided_at)})`}>
            <Badge tone="danger">Voided</Badge>
          </span>
        )}
      </span>
    ),
  }),
  h.accessor('amount', {
    header: 'Amount',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row: { original: ch } }) => (
      <span className={cn('font-medium', ch.voided_at && 'text-muted-foreground line-through')}>
        {formatCurrency(ch.amount)}
      </span>
    ),
  }),
  h.display({
    id: 'period',
    header: 'Period',
    meta: { csv: (ch: Charge) => `${ch.period_start} – ${ch.period_end}`, csvHeader: 'Period' },
    cell: ({ row: { original: ch } }) => (
      <span className="text-xs text-muted-foreground">
        {formatDate(ch.period_start)} – {formatDate(ch.period_end)}
      </span>
    ),
  }),
  h.accessor('source', { header: 'Source', cell: ({ row }) => <StatusBadge status={row.original.source} /> }),
]

export function BillingDashboard() {
  return (
    <div>
      <PageHeader title="Billing" />
      <DataTable<Charge>
        columns={columns}
        queryKey={['charges', 'list']}
        fetchPage={(p) => api.list<Charge>('/charges', p)}
        searchable={false}
        csvFilename={csvFilename('billing')}
        initialSort={{ id: 'charge_date', desc: true }}
        emptyTitle="No charges yet"
      />
    </div>
  )
}
