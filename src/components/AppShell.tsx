import { Link, useLocation } from 'react-router'

type NavItem = { to: string; label: string }
type NavGroup = { heading: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { heading: 'Overview', items: [
    { to: '/', label: 'Dashboard' },
    { to: '/critical-dates', label: 'Critical Dates' },
  ]},
  { heading: 'Assets', items: [
    { to: '/properties', label: 'Properties' },
    { to: '/units', label: 'Unit Matrix' },
    { to: '/tenants', label: 'Tenants' },
    { to: '/leases', label: 'Leases' },
    { to: '/renewals', label: 'Renewals' },
    { to: '/insurance', label: 'Insurance' },
  ]},
  { heading: 'Financials', items: [
    { to: '/billing', label: 'Billing' },
    { to: '/payments', label: 'Payments' },
    { to: '/ar', label: 'AR / Collections' },
    { to: '/cam', label: 'CAM' },
    { to: '/expenses', label: 'Expenses' },
    { to: '/budgets', label: 'Budgets' },
  ]},
  { heading: 'Reports', items: [
    { to: '/rent-roll', label: 'Rent Roll' },
    { to: '/exports', label: 'QB Export' },
  ]},
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div className="flex h-screen bg-ivory">
      <aside className="w-60 bg-navy text-white flex flex-col shrink-0">
        <div className="px-5 py-5 border-b border-white/10">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gold">Oxford Realty</p>
          <p className="text-sm font-display mt-0.5">Property Manager</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-3">
          {NAV.map(group => (
            <div key={group.heading} className="mb-4">
              <p className="px-5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{group.heading}</p>
              {group.items.map(({ to, label }) => {
                const active = pathname === to
                return (
                  <Link
                    key={to}
                    to={to}
                    className={`flex items-center pl-5 pr-4 py-1.5 text-sm transition-colors border-l-2 ${
                      active
                        ? 'border-gold bg-white/5 text-white font-medium'
                        : 'border-transparent text-white/70 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {label}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-white/10 text-[11px] text-white/40 font-mono">
          ORA PM · v1
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  )
}
