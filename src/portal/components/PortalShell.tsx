import { Link, useLocation } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { portalSupabase } from '../lib/supabase-portal'

const NAV = [
  { to: '/portal', label: 'Dashboard' },
  { to: '/portal/pay', label: 'Pay Now' },
  { to: '/portal/payments', label: 'Payment History' },
  { to: '/portal/lease', label: 'My Lease' },
  { to: '/portal/documents', label: 'Documents' },
  { to: '/portal/insurance', label: 'Insurance' },
  { to: '/portal/account', label: 'Account' },
]

export function PortalShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const { pathname } = useLocation()

  return (
    <div className="min-h-screen bg-ivory">
      <header className="bg-navy text-white px-6 py-4 flex justify-between items-center">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gold">Oxford Realty Advisors</p>
          <p className="font-display text-lg leading-tight">Tenant Portal</p>
        </div>
        <span className="text-sm text-white/70 font-mono">{session.user.email}</span>
      </header>
      <div className="flex flex-col sm:flex-row">
        <nav className="sm:w-52 bg-parchment sm:min-h-screen border-b sm:border-b-0 sm:border-r border-navy/10 py-3 flex sm:block overflow-x-auto">
          {NAV.map(({ to, label }) => {
            const active = pathname === to
            return (
              <Link
                key={to}
                to={to}
                className={`block whitespace-nowrap px-5 py-2.5 text-sm transition-colors border-l-2 ${
                  active
                    ? 'border-gold bg-white text-navy font-medium'
                    : 'border-transparent text-navy/70 hover:text-navy hover:bg-white/50'
                }`}
              >
                {label}
              </Link>
            )
          })}
          <button
            onClick={() => portalSupabase.auth.signOut()}
            className="block w-full text-left px-5 py-2.5 text-sm text-status-neutral hover:text-navy sm:mt-4 sm:border-t border-navy/10"
          >
            Sign out
          </button>
        </nav>
        <main className="flex-1 p-6 sm:p-8">{children}</main>
      </div>
    </div>
  )
}
