import { Link, useLocation } from 'react-router-dom'
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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-[#1B2A4A] text-white px-6 py-4 flex justify-between items-center">
        <span className="font-semibold text-lg">Oxford Realty Advisors — Tenant Portal</span>
        <span className="text-sm text-gray-300">{session.user.email}</span>
      </header>
      <div className="flex">
        <nav className="w-48 min-h-screen bg-white border-r border-gray-200 pt-4">
          {NAV.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`block px-4 py-2.5 text-sm ${pathname === to ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
            >
              {label}
            </Link>
          ))}
          <button
            onClick={() => portalSupabase.auth.signOut()}
            className="block w-full text-left px-4 py-2.5 text-sm text-gray-500 hover:bg-gray-50 mt-4 border-t border-gray-100"
          >
            Sign out
          </button>
        </nav>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  )
}
