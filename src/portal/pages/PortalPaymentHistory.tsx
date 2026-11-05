import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { formatCurrency } from '../../lib/format'
import type { Payment } from '../lib/portal-api'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/QueryState'

const STATUS_BADGE: Record<string, string> = {
  succeeded: 'bg-status-active/10 text-status-active',
  processing: 'bg-status-warning/10 text-status-warning',
  // OI-065/223/233 review follow-up: a payment-intent reservation (0014) is
  // written as 'pending' before Stripe is even called, and stays that way
  // until write-back or the webhook resolves it. Same visual treatment as
  // 'processing' — both mean "not yet settled, nothing to do" from a tenant's
  // view — rather than falling through to the generic untitled gray badge.
  pending: 'bg-status-warning/10 text-status-warning',
  failed: 'bg-status-danger/10 text-status-danger',
  returned: 'bg-status-danger/10 text-status-danger',
}

export function PortalPaymentHistory() {
  const query = useQuery({ queryKey: ['portal-payments'], queryFn: portalApi.getPayments })
  const payments = (query.data?.data ?? []) as Payment[]

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <h1 className="font-display text-2xl text-navy">Payment History</h1>
      <QueryState query={query}>
        {payments.length === 0 ? (
          <p className="text-status-neutral text-sm">No payments on record.</p>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-parchment border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-navy">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-navy">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-navy">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-navy">Notes</th>
                </tr>
              </thead>
              <tbody>
                {payments.map(p => {
                  const status = p.stripe_status ?? 'recorded'
                  return (
                    <tr key={p.id} className="border-b border-border/50 hover:bg-parchment/50">
                      <td className="px-4 py-3 text-navy">{p.payment_date.slice(0, 10)}</td>
                      <td className="px-4 py-3 font-semibold">{formatCurrency(p.amount)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${STATUS_BADGE[status] ?? 'bg-status-neutral/10 text-status-neutral'}`}>
                          {status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-status-neutral text-xs">{p.notes ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        )}
      </QueryState>
    </div>
  )
}
