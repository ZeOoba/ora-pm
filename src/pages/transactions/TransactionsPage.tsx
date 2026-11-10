import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { ReportFilters } from '../../components/ReportFilters'
import { KpiStat } from '../../components/ui/KpiStat'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { formatCurrency, formatDate } from '../../lib/format'
import { useReportFilters, reportQuery } from '../../lib/report-filters'
import type { CashActivityResponse, CashActivityRow } from '../../lib/report-types'

const h = dataTableColumnHelper<CashActivityRow>()

const BASE_COLUMNS = [
  h.accessor('date', { header: 'Date', enableSorting: true, cell: ({ row }) => formatDate(row.original.date) }),
  h.accessor('kind', {
    header: 'Type',
    enableSorting: true,
    meta: { csv: (r: CashActivityRow) => (r.kind === 'cash_in' ? 'Cash In' : 'Cash Out') },
    cell: ({ row }) => (
      <Badge tone={row.original.kind === 'cash_in' ? 'active' : 'danger'}>
        {row.original.kind === 'cash_in' ? 'Cash In' : 'Cash Out'}
      </Badge>
    ),
  }),
  h.accessor('party', { header: 'Party', enableSorting: true }),
  h.accessor((r) => `${r.property_name ?? ''}${r.suite ? ` - ${r.suite}` : ''}`, { id: 'property', header: 'Property', enableSorting: true }),
  h.accessor('description', { header: 'Description' }),
  h.accessor('amount', {
    header: 'Amount',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => (
      <span className={row.original.amount < 0 ? 'text-status-danger' : 'text-foreground'}>{formatCurrency(row.original.amount)}</span>
    ),
  }),
]
const RUNNING_NET = h.accessor('running_net', {
  header: 'Period Net',
  meta: { numeric: true },
  cell: ({ row }) => <span className="font-mono">{formatCurrency(row.original.running_net)}</span>,
})

const TYPE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'cash_in', label: 'Cash In' },
  { value: 'cash_out', label: 'Cash Out' },
] as const

function matchesSearch(r: CashActivityRow, q: string): boolean {
  const needle = q.toLowerCase()
  return [r.party, r.property_name, r.suite, r.description].some((v) => v?.toLowerCase().includes(needle))
}

export function TransactionsPage() {
  const filters = useReportFilters()
  const qs = reportQuery(filters)
  const [sp, setSp] = useSearchParams()
  const type = sp.get('type') === 'cash_in' || sp.get('type') === 'cash_out' ? sp.get('type')! : ''

  const q = useQuery({
    queryKey: ['cash-activity', qs],
    queryFn: () => api.get<CashActivityResponse>(`/reports/cash-activity?${qs}`),
  })
  const rows = useMemo(() => (q.data ? q.data.data.filter((r) => !type || r.kind === type) : undefined), [q.data, type])
  // The running net spans both directions, so it is only meaningful on the unfiltered ledger.
  const columns = useMemo(() => (type ? BASE_COLUMNS : [...BASE_COLUMNS, RUNNING_NET]), [type])
  const t = q.data?.totals

  const setType = (v: string) => {
    const next = new URLSearchParams(sp)
    if (v) next.set('type', v)
    else next.delete('type')
    setSp(next, { replace: true })
  }

  return (
    <div>
      <PageHeader title="Transactions" subtitle={filters.range.label} />
      <ReportFilters filters={filters} />

      <Card className="mb-6 p-4">
        <h2 className="mb-3 font-display text-base text-navy">Summary</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiStat accent="positive" label="Total Cash In" value={formatCurrency(t?.cash_in)} sub="Payments received" />
          <KpiStat accent="negative" label="Cash Out" value={formatCurrency(t?.cash_out)} sub="Expenses recorded" />
          <KpiStat accent="navy" label="Net Cash Flow" value={formatCurrency(t?.net)} sub="Cash in − cash out" />
        </div>
        {t && t.pending_ach > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {formatCurrency(t.pending_ach)} of ACH payments are still pending or processing and are not counted until they settle.
          </p>
        )}
      </Card>

      <div className="mb-3 inline-flex rounded-md border border-border bg-card p-0.5" role="group" aria-label="Transaction type">
        {TYPE_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={type === o.value}
            onClick={() => setType(o.value)}
            className={`rounded px-3 py-1 text-sm ${type === o.value ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'}`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <DataTable<CashActivityRow>
        mode="client"
        columns={columns}
        queryKey={['cash-activity', 'table', qs, type]}
        rows={rows}
        error={q.error}
        onRetry={() => void q.refetch()}
        getRowId={(r) => `${r.kind}-${r.id}`}
        clientSearchFn={matchesSearch}
        searchPlaceholder="Search party, property or description…"
        csvFilename={csvFilename('transactions')}
        emptyTitle="No transactions in this period"
      />
    </div>
  )
}
