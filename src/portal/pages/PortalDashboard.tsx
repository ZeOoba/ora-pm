import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { formatCurrency, formatDate } from '../../lib/format'
import { Skeleton } from '../../components/ui/skeleton'
import { QueryState } from '../../components/QueryState'

const RECENT_CHARGES = 6

/**
 * Tenant portal home (Claude Design "ORA PM" prototype, screen 4a): leads with the balance and
 * a single "Pay now" path into the existing Pay Now flow. Payment itself stays on /portal/pay —
 * this page never creates a PaymentIntent.
 */
export function PortalDashboard() {
  const meQuery = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const paymentsQuery = useQuery({ queryKey: ['portal-payments'], queryFn: portalApi.getPayments })
  const chargesQuery = useQuery({ queryKey: ['portal-charges'], queryFn: portalApi.getCharges })
  const leaseQuery = useQuery({ queryKey: ['portal-lease'], queryFn: portalApi.getLease })

  // total_balance is plain dollars from ar_ledger (server/routes/portal.ts /me).
  const balance = meQuery.data?.total_balance ?? 0
  const lastPayment = paymentsQuery.data?.data[0] ?? null
  // No per-row paid/open column on charges and no payments-to-charge link (schema gap — see
  // 2026-07-16 audit finding #7), so these are shown as recent charges, not as "open" ones.
  const charges = (chargesQuery.data?.data ?? []).slice(0, RECENT_CHARGES)
  const leases = leaseQuery.data?.data ?? []
  const nextEnd = leases.map((l) => l.end_date).filter(Boolean).sort()[0] ?? null
  const autopayOn = leases.length > 0 && leases.every((l) => l.autopay_enabled)
  const place = leases[0]?.units ? `${leases[0].units.properties?.name ?? ''} · Suite ${leases[0].units.suite}` : null

  const skeleton = (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-48 w-full" />
    </div>
  )

  return (
    <div className="mx-auto w-full max-w-6xl">
      <QueryState query={[meQuery, paymentsQuery, chargesQuery, leaseQuery]} skeleton={skeleton}>
        <div className="flex flex-wrap items-start gap-8">
          <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-7">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted-foreground">
                Welcome, {meQuery.data?.tenant.name}{place ? ` · ${place}` : ''}
              </span>
              {balance > 0 ? (
                <h1 className="font-display text-4xl leading-tight text-navy md:text-[44px]">
                  You owe <span className="text-status-danger">{formatCurrency(balance)}</span>.
                </h1>
              ) : (
                <h1 className="font-display text-4xl leading-tight text-navy md:text-[44px]">
                  {balance < 0 ? <>You have a credit of <span className="text-status-active">{formatCurrency(-balance)}</span>.</> : 'You have no balance due.'}
                </h1>
              )}
              {balance > 0 && (
                <Link to="/portal/pay" className="mt-2 rounded-xl bg-navy py-3 text-center text-[15px] font-semibold text-white hover:bg-navy-700 sm:hidden">
                  Pay now
                </Link>
              )}
            </div>

            <section aria-label="Recent charges" className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-baseline justify-between border-b border-border px-4.5 py-3.5">
                <h2 className="font-display text-xl text-navy">Recent charges</h2>
                <Link to="/portal/payments" className="text-[13px] text-muted-foreground hover:text-navy">Payment history →</Link>
              </div>
              {charges.length === 0 && <p className="px-4.5 py-6 text-sm text-muted-foreground">No charges on your active lease.</p>}
              {charges.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3.5 border-t border-border/60 px-4.5 py-3 text-sm first:border-t-0">
                  <div className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-4">
                    <span className="capitalize text-navy">{(c.description ?? c.type).replace(/_/g, ' ')}</span>
                    <span className="text-xs text-muted-foreground">Due {formatDate(c.due_date)}</span>
                  </div>
                  <span className="shrink-0 text-right font-mono">{formatCurrency(c.amount)}</span>
                </div>
              ))}
            </section>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
              <Tile label="Last payment" value={lastPayment ? formatCurrency(lastPayment.amount) : '—'}
                sub={lastPayment ? `${formatDate(lastPayment.payment_date)} · ${lastPayment.stripe_status.replace(/_/g, ' ')}` : 'No payments on record'} />
              <Tile label="Lease ends" value={nextEnd ? formatDate(nextEnd) : '—'} sub={<Link to="/portal/lease" className="hover:text-navy">View my lease →</Link>} />
              <Tile label="Insurance certificate" value="Upload" sub={<Link to="/portal/insurance" className="hover:text-navy">Send a new COI →</Link>} />
            </div>
          </div>

          <aside aria-label="Make a payment" className="flex min-w-0 flex-[1_1_320px] flex-col gap-4 self-start rounded-2xl border border-border bg-card p-6 shadow-lg">
            <h2 className="font-display text-2xl text-navy">Make a payment</h2>
            <div className="flex items-baseline justify-between rounded-xl border border-navy bg-gold/10 px-3.5 py-3">
              <span className="text-sm">Current balance</span>
              <span className="font-mono text-sm">{formatCurrency(Math.max(0, balance))}</span>
            </div>
            {balance > 0 ? (
              <Link to="/portal/pay" className="rounded-xl bg-navy py-3.5 text-center text-[15px] font-semibold text-white hover:bg-navy-700">
                Pay now
              </Link>
            ) : (
              <span className="rounded-xl border border-border py-3.5 text-center text-[15px] text-muted-foreground">Nothing due</span>
            )}
            <p className="text-xs text-muted-foreground">Bank (ACH) payments typically settle in 3–5 business days. You choose which charges to pay on the next screen.</p>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Autopay is {autopayOn ? 'on' : 'off'}</span>
              <Link to="/portal/account" className="font-semibold text-navy">{autopayOn ? 'Manage autopay →' : 'Turn on autopay →'}</Link>
            </div>
          </aside>
        </div>
      </QueryState>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-display text-[26px] leading-tight text-navy">{value}</span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </div>
  )
}
