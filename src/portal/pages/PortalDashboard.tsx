import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'

function fmt(cents: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function PortalDashboard() {
  const meQuery = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const paymentsQuery = useQuery({ queryKey: ['portal-payments'], queryFn: portalApi.getPayments })
  const chargesQuery = useQuery({ queryKey: ['portal-charges'], queryFn: portalApi.getCharges })

  const balance = meQuery.data?.total_balance ?? 0
  const lastPayment = paymentsQuery.data?.data[0] ?? null
  const openCharges = (chargesQuery.data?.data ?? []).filter(c => c.status === 'open')

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-serif mb-6" style={{ color: '#1B2A4A' }}>
        {meQuery.data ? `Welcome, ${meQuery.data.tenant.name}` : 'Dashboard'}
      </h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {/* Balance card */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Outstanding Balance</p>
          {meQuery.isLoading ? (
            <div className="h-8 w-28 bg-gray-100 animate-pulse rounded" />
          ) : (
            <p className="text-3xl font-semibold" style={{ color: balance > 0 ? '#B91C1C' : '#166534' }}>
              {fmt(balance)}
            </p>
          )}
        </div>

        {/* Last payment card */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Last Payment</p>
          {paymentsQuery.isLoading ? (
            <div className="h-8 w-28 bg-gray-100 animate-pulse rounded" />
          ) : lastPayment ? (
            <>
              <p className="text-2xl font-semibold text-gray-800">{fmt(lastPayment.amount)}</p>
              <p className="text-sm text-gray-500 mt-1">{fmtDate(lastPayment.payment_date)}</p>
            </>
          ) : (
            <p className="text-sm text-gray-400 mt-2">No payments on record</p>
          )}
        </div>

        {/* Open charges card */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Open Charges</p>
          {chargesQuery.isLoading ? (
            <div className="h-8 w-16 bg-gray-100 animate-pulse rounded" />
          ) : (
            <p className="text-3xl font-semibold text-gray-800">{openCharges.length}</p>
          )}
        </div>
      </div>

      {/* Open charges list */}
      {openCharges.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="font-medium text-gray-700">Open Charges</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-5 py-2 text-left">Description</th>
                <th className="px-5 py-2 text-left">Due</th>
                <th className="px-5 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {openCharges.map(c => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-5 py-3 text-gray-700">{c.description ?? c.charge_type}</td>
                  <td className="px-5 py-3 text-gray-500">{fmtDate(c.due_date)}</td>
                  <td className="px-5 py-3 text-right font-medium text-gray-800">{fmt(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(meQuery.isError || paymentsQuery.isError || chargesQuery.isError) && (
        <p className="mt-4 text-sm text-red-600">
          Failed to load some data. Please refresh.
        </p>
      )}
    </div>
  )
}
