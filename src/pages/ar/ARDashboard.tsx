import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { QueryState } from '../../components/QueryState'
import { EmptyState } from '../../components/ui/EmptyState'
import { AgingChart } from '../../components/charts/AgingChart'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { formatCurrency } from '../../lib/format'
import type { ARLedgerRow } from '../../types'
import { AGING_COLUMNS, UNALLOCATED_COLUMN, hasUnallocated, type AgingBuckets, type AgingTotals } from './ar-aging-view'

type AgingRow = ARLedgerRow & { buckets: AgingBuckets }
type AgingResponse = { data: AgingRow[]; totals: AgingTotals }

export function ARDashboard() {
  // Shares ['ar-aging', 'buckets'] (same full response: rows + totals) with Dashboard, so the two
  // views read one cache entry. invalidateQueries(['ar-aging']) prefix-matches it.
  const query = useQuery({
    queryKey: ['ar-aging', 'buckets'],
    queryFn: () => api.get<AgingResponse>('/reports/ar-aging'),
  })
  const rows = query.data?.data ?? []
  const totals = query.data?.totals

  const totalCharged = rows.reduce((s, r) => s + r.total_charged, 0)
  const totalPaid = rows.reduce((s, r) => s + r.total_paid, 0)
  const showUnallocated = hasUnallocated(totals)
  const bucketCols = showUnallocated ? [...AGING_COLUMNS, UNALLOCATED_COLUMN] : AGING_COLUMNS

  return (
    <div>
      <PageHeader title="AR / Collections" subtitle="Aging assumes payments retire the oldest charges first." />

      <QueryState
        query={query}
        isEmpty={(d) => (d as AgingResponse | undefined)?.data.length === 0}
        empty={<EmptyState title="No outstanding balances" message="Every lease is paid up." />}
      >
        {totals && (
          <>
            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[
                { label: 'Total Outstanding', value: totals.balance, danger: totals.balance > 0 },
                { label: 'Total Charged', value: totalCharged },
                { label: 'Total Paid', value: totalPaid },
              ].map(({ label, value, danger }) => (
                <div key={label} className={`rounded-lg border p-4 ${danger ? 'border-status-danger/30 bg-status-danger/5' : 'border-border bg-card'}`}>
                  <p className="text-xs uppercase text-status-neutral">{label}</p>
                  <p className={`mt-1 font-mono text-2xl font-bold ${danger ? 'text-status-danger' : 'text-navy'}`}>{formatCurrency(value)}</p>
                </div>
              ))}
            </div>

            <AgingChart totals={totals} />

            {showUnallocated && (
              <p role="status" className="mb-3 rounded-md border border-status-warning/30 bg-status-warning/5 px-4 py-2 text-sm text-status-warning">
                {formatCurrency(totals.unallocated)} of the balance is not explained by the leases' current charges
                (shown as Unallocated). Check for charges voided or edited since the balance was computed.
              </p>
            )}

            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Property</TableHead>
                    <TableHead>Suite</TableHead>
                    <TableHead className="text-right">Total Charged</TableHead>
                    <TableHead className="text-right">Total Paid</TableHead>
                    {bucketCols.map((c) => <TableHead key={c.key} className="text-right">{c.label}</TableHead>)}
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.lease_id}>
                      <TableCell className="font-medium text-navy">{row.tenant_name}</TableCell>
                      <TableCell className="text-status-neutral">{row.property_name}</TableCell>
                      <TableCell className="text-status-neutral">{row.suite}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(row.total_charged)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(row.total_paid)}</TableCell>
                      {bucketCols.map((c) => (
                        <TableCell key={c.key} className={`text-right font-mono ${row.buckets[c.key] === 0 ? 'text-status-neutral/60' : ''}`}>
                          {formatCurrency(row.buckets[c.key])}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-mono font-semibold text-status-danger">{formatCurrency(row.balance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={3} className="font-medium">Portfolio total</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(totalCharged)}</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(totalPaid)}</TableCell>
                    {bucketCols.map((c) => (
                      <TableCell key={c.key} className="text-right font-mono">{formatCurrency(totals[c.key])}</TableCell>
                    ))}
                    <TableCell className="text-right font-mono font-semibold">{formatCurrency(totals.balance)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </>
        )}
      </QueryState>
    </div>
  )
}
