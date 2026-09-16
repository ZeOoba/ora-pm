import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { formatCurrency } from '../../lib/format'
import type { Payment } from '../lib/portal-api'

const STATUS_BADGE: Record<string, string> = {
  succeeded: 'bg-green-100 text-green-700',
  processing: 'bg-yellow-100 text-yellow-700',
  // OI-065/223/233 review follow-up: a payment-intent reservation (0014) is
  // written as 'pending' before Stripe is even called, and stays that way
  // until write-back or the webhook resolves it. Same visual treatment as
  // 'processing' — both mean "not yet settled, nothing to do" from a tenant's
  // view — rather than falling through to the generic untitled gray badge.
  pending: 'bg-yellow-100 text-yellow-700',
  failed: 'bg-red-100 text-red-700',
  returned: 'bg-red-100 text-red-700',
}

export function PortalPaymentHistory() {
  const { data, isLoading } = useQuery({ queryKey: ['portal-payments'], queryFn: portalApi.getPayments })
  const payments = (data?.data ?? []) as Payment[]

  if (isLoading) return <div className="p-6 text-gray-500">Loading…</div>

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <h1 className="text-2xl font-serif" style={{ color: '#1B2A4A' }}>Payment History</h1>
      {payments.length === 0 ? (
        <p className="text-gray-500 text-sm">No payments on record.</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-700">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-700">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-gray-700">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-700">Notes</th>
              </tr>
            </thead>
            <tbody>
              {payments.map(p => {
                const status = p.stripe_status ?? 'recorded'
                return (
                  <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{p.payment_date.slice(0, 10)}</td>
                    <td className="px-4 py-3 font-semibold">{formatCurrency(p.amount)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${STATUS_BADGE[status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{p.notes ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
