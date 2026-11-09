import {
  Banknote,
  Building2,
  CalendarClock,
  CalendarSync,
  Download,
  FileSpreadsheet,
  FileText,
  Grid2x2,
  HandCoins,
  Home,
  Landmark,
  Receipt,
  ReceiptText,
  ScrollText,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = { to: string; label: string; icon: LucideIcon }
export type NavGroup = { heading: string; items: NavItem[] }
export type Crumb = { label: string; to?: string }

/** Only routes that exist in src/router.tsx (enforced by tests/components/nav-config.test.ts). */
export const NAV_GROUPS: NavGroup[] = [
  { heading: 'Home', items: [{ to: '/', label: 'Dashboard', icon: Home }] },
  {
    heading: 'Portfolio',
    items: [
      { to: '/properties', label: 'Properties', icon: Building2 },
      { to: '/units', label: 'Units', icon: Grid2x2 },
      { to: '/tenants', label: 'Tenants', icon: Users },
      { to: '/leases', label: 'Leases', icon: FileText },
      { to: '/insurance', label: 'Insurance', icon: ShieldCheck },
    ],
  },
  {
    heading: 'Leasing',
    items: [
      { to: '/renewals', label: 'Renewals', icon: CalendarSync },
      { to: '/critical-dates', label: 'Critical Dates', icon: CalendarClock },
    ],
  },
  {
    heading: 'Accounting',
    items: [
      { to: '/billing', label: 'Billing', icon: Receipt },
      { to: '/payments', label: 'Payments', icon: Banknote },
      { to: '/ar', label: 'AR / Collections', icon: HandCoins },
      { to: '/statements', label: 'Statements', icon: FileSpreadsheet },
      { to: '/cam', label: 'CAM', icon: Landmark },
      { to: '/expenses', label: 'Expenses', icon: ReceiptText },
      { to: '/budgets', label: 'Budgets', icon: Wallet },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { to: '/rent-roll', label: 'Rent Roll', icon: ScrollText },
      { to: '/exports', label: 'QB Export', icon: Download },
    ],
  },
]

export function flatNavItems(): NavItem[] {
  return NAV_GROUPS.flatMap((g) => g.items)
}

const SEGMENT_LABELS: Record<string, string> = { new: 'New', edit: 'Edit', intake: 'Intake' }

/** Whether `pathname` is the nav item's page or beneath it (e.g. /leases/123 under /leases). */
export function isNavActive(pathname: string, to: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)
}

/** Breadcrumb trail derived from nav-config + pathname; [] for paths outside the nav. */
export function breadcrumbFor(pathname: string): Crumb[] {
  if (pathname === '/') return [{ label: 'Home', to: '/' }]
  const [first, ...rest] = pathname.split('/').filter(Boolean)
  const base = `/${first}`
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.to === base)
    if (!item) continue
    return [
      { label: group.heading },
      { label: item.label, to: item.to },
      ...rest.map((seg) => ({ label: SEGMENT_LABELS[seg] ?? 'Detail' })),
    ]
  }
  return []
}
