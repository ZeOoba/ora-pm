import { Link, useLocation } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { portalSupabase } from '../lib/supabase-portal'

const NAV = [
  { to: '/portal', label: 'Home' },
  { to: '/portal/pay', label: 'Pay Now' },
  { to: '/portal/payments', label: 'Payment History' },
  { to: '/portal/lease', label: 'My Lease' },
  { to: '/portal/documents', label: 'Documents' },
  { to: '/portal/insurance', label: 'Insurance' },
  { to: '/portal/account', label: 'Account' },
]

/**
 * Tenant portal frame (prototype screen 4a): white header with the landlord name and a tab row.
 * The tab row scrolls sideways on phones instead of wrapping.
 */
export function PortalShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const { pathname } = useLocation()

  return (
    <div className="min-h-screen bg-ivory">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pt-4 sm:px-8">
          <div className="flex flex-col">
            <span className="font-display text-xl leading-tight text-navy">Oxford Realty Advisors</span>
            <span className="text-[11px] text-muted-foreground">Tenant portal</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{session.user.email}</span>
            <button
              type="button"
              onClick={() => portalSupabase.auth.signOut()}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-navy"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav aria-label="Portal" className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-4 text-sm sm:px-8">
          {NAV.map(({ to, label }) => {
            const active = pathname === to
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap border-b-2 py-3 transition-colors ${
                  active ? 'border-navy font-semibold text-navy' : 'border-transparent text-muted-foreground hover:text-navy'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-9">{children}</main>
    </div>
  )
}
