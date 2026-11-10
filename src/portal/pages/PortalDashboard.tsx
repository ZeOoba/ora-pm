import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { Skeleton } from '../../components/ui/skeleton'
import { QueryState } from '../../components/QueryState'
import { PortalHomeView } from '../components/PortalHomeView'

/**
 * Tenant portal home (Claude Design "ORA PM" prototype, screen 4a): leads with the balance and
 * a single "Pay now" path into the existing Pay Now flow. Payment itself stays on /portal/pay —
 * this page never creates a PaymentIntent. Rendering lives in PortalHomeView (shared with the
 * admin "View as tenant" preview, B13); this page only loads the tenant's own data.
 */
export function PortalDashboard() {
  const meQuery = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const paymentsQuery = useQuery({ queryKey: ['portal-payments'], queryFn: portalApi.getPayments })
  const chargesQuery = useQuery({ queryKey: ['portal-charges'], queryFn: portalApi.getCharges })
  const leaseQuery = useQuery({ queryKey: ['portal-lease'], queryFn: portalApi.getLease })
  // The balance breakdown is an addition: if it fails, the page still shows the balance and pay
  // path, and simply omits the breakdown (never a guessed one).
  const agingQuery = useQuery({ queryKey: ['portal-aging'], queryFn: portalApi.getAging })

  const skeleton = (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-48 w-full" />
    </div>
  )

  return (
    <div className="mx-auto w-full max-w-6xl">
      <QueryState query={[meQuery, paymentsQuery, chargesQuery, leaseQuery]} skeleton={skeleton}>
        {meQuery.data && (
          <PortalHomeView data={{
            me: meQuery.data,
            charges: chargesQuery.data?.data ?? [],
            payments: paymentsQuery.data?.data ?? [],
            leases: leaseQuery.data?.data ?? [],
            aging: agingQuery?.data,
          }} />
        )}
      </QueryState>
    </div>
  )
}
