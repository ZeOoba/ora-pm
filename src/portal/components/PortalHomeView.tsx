import { Link } from 'react-router'
import { formatCurrency, formatDate } from '../../lib/format'
import type { Charge, Lease, Payment, PortalAging, TenantMe } from '../lib/portal-api'

const RECENT_CHARGES = 6

export interface PortalHomeData {
  me: TenantMe
  charges: Charge[]
  payments: Payment[]
  leases: Lease[]
  /** Undefined while loading or when its read failed: the breakdown is then omitted, never guessed. */
  aging?: PortalAging
}

const BUCKETS: { key: keyof PortalAging['totals']; label: string }[] = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd1_30', label: '1–30 days past due' },
  { key: 'd31_60', label: '31–60 days past due' },
  { key: 'd61_90', label: '61–90 days past due' },
  { key: 'd90_plus', label: 'Over 90 days past due' },
  { key: 'unallocated', label: 'Not matched to a charge' },
]

/** Past-due part of the aged balance: everything outside `current` and `unallocated`. */
function pastDueOf(t: PortalAging['totals']): number {
  return t.d1_30 + t.d31_60 + t.d61_90 + t.d90_plus
}

/**
 * The tenant portal home, presentational only (B13): the tenant's own page (PortalDashboard) and
 * the admin "View as tenant" preview render this with the same payloads, so they cannot diverge.
 * In `preview` mode the portal links render as inert text, so an admin never navigates into a
 * portal route with their own session. Payment itself stays on /portal/pay; nothing here creates
 * a PaymentIntent.
 */
export function PortalHomeView({ data, preview = false }: { data: PortalHomeData; preview?: boolean }) {
  // total_balance is plain dollars: the signed sum of the tenant's ar_ledger rows (credits included).
  const balance = data.me.total_balance
  const lastPayment = data.payments[0] ?? null
  // No per-row paid/open column on charges and no payments-to-charge link (schema gap — see
  // 2026-07-16 audit finding #7), so these are shown as recent charges, not as "open" ones.
  const charges = data.charges.slice(0, RECENT_CHARGES)
  const leases = data.leases
  const nextEnd = leases.map((l) => l.end_date).filter(Boolean).sort()[0] ?? null
  const autopayOn = leases.length > 0 && leases.every((l) => l.autopay_enabled)
  const place = leases[0]?.units ? `${leases[0].units.properties?.name ?? ''} · Suite ${leases[0].units.suite}` : null
  const totals = data.aging?.totals
  const pastDue = totals ? pastDueOf(totals) : 0
  // Aging covers positive-balance leases only; the gap to the signed balance is credit on account.
  // Half-cent tolerance absorbs float noise; formatCurrency rounds for display.
  const credit = totals ? balance - totals.balance : 0

  return (
    <div className="flex flex-wrap items-start gap-8">
      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-7">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-foreground">
            Welcome, {data.me.tenant.name}{place ? ` · ${place}` : ''}
          </span>
          {balance > 0 ? (
            <h1 className="font-display text-4xl leading-tight text-navy md:text-[44px]">
              You owe <span className="text-status-danger">{formatCurrency(balance)}</span>.
              {pastDue > 0 && <><br /><span className="text-2xl md:text-3xl">{formatCurrency(pastDue)} of that is past due.</span></>}
            </h1>
          ) : (
            <h1 className="font-display text-4xl leading-tight text-navy md:text-[44px]">
              {balance < 0 ? <>You have a credit of <span className="text-status-active">{formatCurrency(-balance)}</span>.</> : 'You have no balance due.'}
            </h1>
          )}
          {balance > 0 && (
            <PortalLink preview={preview} to="/portal/pay" className="mt-2 rounded-xl bg-navy py-3 text-center text-[15px] font-semibold text-white hover:bg-navy-700 sm:hidden">
              Pay now
            </PortalLink>
          )}
        </div>

        {totals && totals.balance > 0 && (
          <section aria-label="What makes up your balance" className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4.5 py-3.5">
              <h2 className="font-display text-xl text-navy">What makes up your balance</h2>
              <p className="text-xs text-muted-foreground">Payments are applied to your oldest charges first.</p>
            </div>
            {BUCKETS.filter((b) => totals[b.key] > 0).map((b) => (
              <div key={b.key} className="flex items-center justify-between gap-3.5 border-t border-border/60 px-4.5 py-3 text-sm first:border-t-0">
                <span className={b.key === 'current' ? 'text-navy' : 'text-status-danger'}>{b.label}</span>
                <span className="shrink-0 font-mono">{formatCurrency(totals[b.key])}</span>
              </div>
            ))}
            {credit < -0.005 && (
              <div className="flex items-center justify-between gap-3.5 border-t border-border/60 px-4.5 py-3 text-sm">
                <span className="text-status-active">Credit on account</span>
                <span className="shrink-0 font-mono">{formatCurrency(credit)}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3.5 border-t border-navy px-4.5 py-3 text-sm font-semibold">
              <span>Balance</span>
              <span className="shrink-0 font-mono">{formatCurrency(balance)}</span>
            </div>
          </section>
        )}

        <section aria-label="Recent charges" className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-baseline justify-between border-b border-border px-4.5 py-3.5">
            <h2 className="font-display text-xl text-navy">Recent charges</h2>
            <PortalLink preview={preview} to="/portal/payments" className="text-[13px] text-muted-foreground hover:text-navy">Payment history →</PortalLink>
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
          <Tile label="Lease ends" value={nextEnd ? formatDate(nextEnd) : '—'} sub={<PortalLink preview={preview} to="/portal/lease" className="hover:text-navy">View my lease →</PortalLink>} />
          <Tile label="Insurance certificate" value="Upload" sub={<PortalLink preview={preview} to="/portal/insurance" className="hover:text-navy">Send a new COI →</PortalLink>} />
        </div>
      </div>

      <aside aria-label="Make a payment" className="flex min-w-0 flex-[1_1_320px] flex-col gap-4 self-start rounded-2xl border border-border bg-card p-6 shadow-lg">
        <h2 className="font-display text-2xl text-navy">Make a payment</h2>
        <div className="flex items-baseline justify-between rounded-xl border border-navy bg-gold/10 px-3.5 py-3">
          <span className="text-sm">Current balance</span>
          <span className="font-mono text-sm">{formatCurrency(Math.max(0, balance))}</span>
        </div>
        {balance > 0 ? (
          <PortalLink preview={preview} to="/portal/pay" className="rounded-xl bg-navy py-3.5 text-center text-[15px] font-semibold text-white hover:bg-navy-700">
            Pay now
          </PortalLink>
        ) : (
          <span className="rounded-xl border border-border py-3.5 text-center text-[15px] text-muted-foreground">Nothing due</span>
        )}
        <p className="text-xs text-muted-foreground">Bank (ACH) payments typically settle in 3–5 business days. You choose which charges to pay on the next screen.</p>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Autopay is {autopayOn ? 'on' : 'off'}</span>
          <PortalLink preview={preview} to="/portal/account" className="font-semibold text-navy">{autopayOn ? 'Manage autopay →' : 'Turn on autopay →'}</PortalLink>
        </div>
      </aside>
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

/** A portal link, or inert text in the admin preview (an admin must not enter portal routes). */
function PortalLink({ preview, to, className, children }: { preview: boolean; to: string; className?: string; children: React.ReactNode }) {
  return preview
    ? <span className={className} title="Link disabled in preview">{children}</span>
    : <Link to={to} className={className}>{children}</Link>
}
