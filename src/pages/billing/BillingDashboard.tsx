import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
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

export function BillingDashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['charges'],
    queryFn: () => api.get<{ data: Charge[] }>('/charges').then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  return (
    <div>
      <PageHeader title="Billing" />
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Charge Date', 'Due Date', 'Type', 'Amount', 'Period', 'Source'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">No charges yet.</td>
              </tr>
            )}
            {data?.map(ch => (
              // OI-278 / migration 0016: voided rows stay in the list as the audit trail but are
              // visibly retired — struck-through amount + "Voided" badge carrying the reason.
              <tr key={ch.id} className={`hover:bg-gray-50 ${ch.voided_at ? 'text-gray-400' : ''}`}>
                <td className="px-4 py-3">{formatDate(ch.charge_date)}</td>
                <td className="px-4 py-3 text-gray-500">{formatDate(ch.due_date)}</td>
                <td className="px-4 py-3">
                  {CHARGE_LABELS[ch.type] ?? ch.type}
                  {ch.voided_at && (
                    <span
                      className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700"
                      title={`${ch.void_reason ?? ''} (${formatDate(ch.voided_at)})`}
                    >
                      Voided
                    </span>
                  )}
                </td>
                <td className={`px-4 py-3 font-medium ${ch.voided_at ? 'line-through' : ''}`}>{formatCurrency(ch.amount)}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {formatDate(ch.period_start)} – {formatDate(ch.period_end)}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    ch.source === 'auto'
                      ? 'bg-purple-100 text-purple-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}>
                    {ch.source}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
