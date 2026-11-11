import {
  ArrowLeftRight,
  Banknote,
  BookOpen,
  Building2,
  CalendarClock,
  CalendarSync,
  Download,
  FileSpreadsheet,
  FileText,
  Grid2x2,
  HandCoins,
  ListTree,
  Scale,
  Home,
  LayoutList,
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
export type NavGroup = { heading?: string; items: NavItem[] }
export type Crumb = { label: string; to?: string }

/**
 * Information architecture from the Claude Design "ORA PM" prototype: Today, then Portfolio ·
 * Leasing · Money · Books. Pages the prototype doesn't name are nested under the closest group so
 * every route stays one click away. Only routes that exist in src/router.tsx (enforced by
 * tests/components/nav-config.test.ts).
 */
export const NAV_GROUPS: NavGroup[] = [
  { items: [{ to: '/', label: 'Today', icon: Home }] },
  {
    heading: 'Portfolio',
    items: [
      { to: '/portfolio', label: 'Overview', icon: LayoutList },
      { to: '/properties', label: 'Properties', icon: Building2 },
      { to: '/units', label: 'Units', icon: Grid2x2 },
      { to: '/tenants', label: 'Tenants', icon: Users },
      { to: '/leases', label: 'Leases', icon: FileText },
      { to: '/rent-roll', label: 'Rent roll', icon: ScrollText },
      { to: '/insurance', label: 'Insurance', icon: ShieldCheck },
    ],
  },
  {
    heading: 'Leasing',
    items: [
      { to: '/renewals', label: 'Renewals', icon: CalendarSync },
      { to: '/critical-dates', label: 'Critical dates', icon: CalendarClock },
    ],
  },
  {
    heading: 'Money',
    items: [
      { to: '/ar', label: 'Collections', icon: HandCoins },
      { to: '/billing', label: 'Billing', icon: Receipt },
      { to: '/payments', label: 'Payments', icon: Banknote },
      { to: '/statements', label: 'Statements', icon: FileSpreadsheet },
      { to: '/cam', label: 'CAM', icon: Landmark },
    ],
  },
  {
    heading: 'Books',
    items: [
      { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
      { to: '/expenses', label: 'Expenses', icon: ReceiptText },
      { to: '/budgets', label: 'Budgets', icon: Wallet },
      { to: '/reports', label: 'Reports', icon: BookOpen },
      { to: '/books/chart-of-accounts', label: 'Chart of accounts', icon: ListTree },
      { to: '/books/opening-balances', label: 'Opening balances', icon: Scale },
      { to: '/exports', label: 'QB export', icon: Download },
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
  if (pathname === '/') return [{ label: 'Today', to: '/' }]
  const [first, ...rest] = pathname.split('/').filter(Boolean)
  const base = `/${first}`
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.to === base)
    if (!item) continue
    return [
      ...(group.heading ? [{ label: group.heading }] : []),
      { label: item.label, to: item.to },
      ...rest.map((seg) => ({ label: SEGMENT_LABELS[seg] ?? 'Detail' })),
    ]
  }
  return []
}
