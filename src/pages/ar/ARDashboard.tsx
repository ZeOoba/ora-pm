import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { formatCurrency } from '../../lib/format'
import type { ARLedgerRow } from '../../types'

export function ARDashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['ar-aging'],
    queryFn: () => api.get<{ data: ARLedgerRow[] }>('/reports/ar-aging').then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  const totalBalance = data?.reduce((s, r) => s + r.balance, 0) ?? 0
  const totalCharged = data?.reduce((s, r) => s + r.total_charged, 0) ?? 0
  const totalPaid    = data?.reduce((s, r) => s + r.total_paid, 0) ?? 0

  return (
    <div>
      <PageHeader title="AR / Collections" />

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total Outstanding', value: totalBalance, danger: totalBalance > 0 },
          { label: 'Total Charged', value: totalCharged },
          { label: 'Total Paid', value: totalPaid },
        ].map(({ label, value, danger }) => (
          <div key={label} className={`rounded-lg border p-4 ${danger ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
            <p className="text-xs text-gray-500 uppercase">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${danger ? 'text-red-700' : 'text-gray-900'}`}>
              {formatCurrency(value)}
            </p>
          </div>
        ))}
      </div>

      {/* Detail table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Tenant', 'Suite', 'Total Charged', 'Total Paid', 'Balance'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">No outstanding balances.</td>
              </tr>
            )}
            {data?.map(row => (
              <tr key={row.lease_id} className={row.balance > 0 ? 'bg-red-50' : ''}>
                <td className="px-4 py-3 font-medium">{row.tenant_name}</td>
                <td className="px-4 py-3 text-gray-500">{row.suite}</td>
                <td className="px-4 py-3">{formatCurrency(row.total_charged)}</td>
                <td className="px-4 py-3">{formatCurrency(row.total_paid)}</td>
                <td className="px-4 py-3 font-semibold text-red-700">{formatCurrency(row.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
