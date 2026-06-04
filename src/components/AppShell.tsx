import { Link, useLocation } from 'react-router-dom'

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/properties', label: 'Properties' },
  { to: '/tenants', label: 'Tenants' },
  { to: '/leases', label: 'Leases' },
  { to: '/billing', label: 'Billing' },
  { to: '/payments', label: 'Payments' },
  { to: '/ar', label: 'AR / Collections' },
  { to: '/cam', label: 'CAM' },
  { to: '/expenses', label: 'Expenses' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/critical-dates', label: 'Critical Dates' },
  { to: '/renewals', label: 'Renewals' },
  { to: '/insurance', label: 'Insurance' },
  { to: '/exports', label: 'QB Export' },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="px-4 py-5 border-b border-gray-200">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Oxford Realty</p>
          <p className="text-sm font-bold text-gray-900 mt-0.5">Property Manager</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {NAV.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`flex items-center px-4 py-2 text-sm transition-colors ${
                pathname === to
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  )
}
