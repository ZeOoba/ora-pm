import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { formatCurrency, formatDate } from '../../lib/format'
import { Card } from '../../components/ui/Card'
import { Skeleton } from '../../components/ui/skeleton'
import { QueryState } from '../../components/QueryState'

export function PortalDashboard() {
  const meQuery = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const paymentsQuery = useQuery({ queryKey: ['portal-payments'], queryFn: portalApi.getPayments })
  const chargesQuery = useQuery({ queryKey: ['portal-charges'], queryFn: portalApi.getCharges })

  const balance = meQuery.data?.total_balance ?? 0
  const lastPayment = paymentsQuery.data?.data[0] ?? null
  // No per-row paid/open column on charges and no payments-to-charge link (schema gap — see
  // 2026-07-16 audit finding #7), so every returned charge is treated as payable, per Gabriel's
  // 2026-07-18 ruling.
  const openCharges = chargesQuery.data?.data ?? []

  const skeleton = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="mb-6 font-display text-2xl text-navy">
        {meQuery.data ? `Welcome, ${meQuery.data.tenant.name}` : 'Dashboard'}
      </h1>

      {/* A failed read shows the error banner (with retry) instead of $0 balances. */}
      <QueryState query={[meQuery, paymentsQuery, chargesQuery]} skeleton={skeleton}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {/* Balance card */}
          <Card className="p-5">
            <p className="text-xs uppercase tracking-wide text-status-neutral mb-1">Outstanding Balance</p>
            <p className={`text-3xl font-semibold ${balance > 0 ? 'text-status-danger' : 'text-status-active'}`}>
              {formatCurrency(balance)}
            </p>
          </Card>

          {/* Last payment card */}
          <Card className="p-5">
            <p className="text-xs uppercase tracking-wide text-status-neutral mb-1">Last Payment</p>
            {lastPayment ? (
              <>
                <p className="text-2xl font-semibold text-navy">{formatCurrency(lastPayment.amount)}</p>
                <p className="text-sm text-status-neutral mt-1">{formatDate(lastPayment.payment_date)}</p>
              </>
            ) : (
              <p className="text-sm text-status-neutral mt-2">No payments on record</p>
            )}
          </Card>

          {/* Open charges card */}
          <Card className="p-5">
            <p className="text-xs uppercase tracking-wide text-status-neutral mb-1">Open Charges</p>
            <p className="text-3xl font-semibold text-navy">{openCharges.length}</p>
          </Card>
        </div>

        {/* Open charges list */}
        {openCharges.length > 0 && (
          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h2 className="font-medium text-navy">Open Charges</h2>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-parchment text-xs uppercase text-status-neutral">
                <tr>
                  <th className="px-5 py-2 text-left">Description</th>
                  <th className="px-5 py-2 text-left">Due</th>
                  <th className="px-5 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {openCharges.map(c => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-5 py-3 text-navy">{c.description ?? c.type}</td>
                    <td className="px-5 py-3 text-status-neutral">{formatDate(c.due_date)}</td>
                    <td className="px-5 py-3 text-right font-medium text-navy">{formatCurrency(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </QueryState>
    </div>
  )
}
