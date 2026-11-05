import { lazy, Suspense } from 'react'
import { createBrowserRouter } from 'react-router'
import { AppShell } from './components/AppShell'
import { AdminAuthGuard } from './components/AdminAuthGuard'
import { PageSkeleton } from './components/PageSkeleton'
import { AdminLogin } from './pages/auth/AdminLogin'
import { PaymentsList }     from './pages/payments/PaymentsList'
import { CAMList }          from './pages/cam/CAMList'
import { ExpensesList }     from './pages/expenses/ExpensesList'
import { BudgetsList }      from './pages/budgets/BudgetsList'
import { InsuranceList }    from './pages/insurance/InsuranceList'

// Route-level code splitting: pages load on demand; AppShell, the auth guard and AdminLogin stay eager.
// All pages use named exports, so adapt each to React.lazy's default-export contract.
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const PropertiesList = lazy(() => import('./pages/properties/PropertiesList').then((m) => ({ default: m.PropertiesList })))
const PropertyForm = lazy(() => import('./pages/properties/PropertyForm').then((m) => ({ default: m.PropertyForm })))
const PropertyDetail = lazy(() => import('./pages/properties/PropertyDetail').then((m) => ({ default: m.PropertyDetail })))
const TenantsList = lazy(() => import('./pages/tenants/TenantsList').then((m) => ({ default: m.TenantsList })))
const TenantForm = lazy(() => import('./pages/tenants/TenantForm').then((m) => ({ default: m.TenantForm })))
const TenantDetail = lazy(() => import('./pages/tenants/TenantDetail').then((m) => ({ default: m.TenantDetail })))
const InsuranceForm = lazy(() => import('./pages/insurance/InsuranceForm').then((m) => ({ default: m.InsuranceForm })))
const LeasesList = lazy(() => import('./pages/leases/LeasesList').then((m) => ({ default: m.LeasesList })))
const LeaseDetail = lazy(() => import('./pages/leases/LeaseDetail').then((m) => ({ default: m.LeaseDetail })))
const LeaseForm = lazy(() => import('./pages/leases/LeaseForm').then((m) => ({ default: m.LeaseForm })))
const LeaseIntake = lazy(() => import('./pages/leases/LeaseIntake').then((m) => ({ default: m.LeaseIntake })))
const BillingDashboard = lazy(() => import('./pages/billing/BillingDashboard').then((m) => ({ default: m.BillingDashboard })))
const ARDashboard = lazy(() => import('./pages/ar/ARDashboard').then((m) => ({ default: m.ARDashboard })))
const CriticalDatesFeed = lazy(() => import('./pages/critical-dates/CriticalDatesFeed').then((m) => ({ default: m.CriticalDatesFeed })))
const QBExport = lazy(() => import('./pages/exports/QBExport').then((m) => ({ default: m.QBExport })))
const RenewalsPipeline = lazy(() => import('./pages/renewals/RenewalsPipeline').then((m) => ({ default: m.RenewalsPipeline })))
const PortalApp = lazy(() => import('./portal/PortalApp').then((m) => ({ default: m.PortalApp })))
const UnitsPage = lazy(() => import('./pages/units/UnitsPage').then((m) => ({ default: m.UnitsPage })))
const RentRoll = lazy(() => import('./pages/reports/RentRoll').then((m) => ({ default: m.RentRoll })))
const StyleGuide = lazy(() => import('./pages/StyleGuide').then((m) => ({ default: m.StyleGuide })))

// Layout is route glue local to this file; `router` (a non-component export) is the real export,
// so Fast Refresh already treats this module as non-refreshable — nothing to gain by splitting it.
// eslint-disable-next-line react-refresh/only-export-components
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AdminAuthGuard>
      <AppShell>
        <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
      </AppShell>
    </AdminAuthGuard>
  )
}

export const router = createBrowserRouter([
  { path: '/login', element: <AdminLogin /> },
  { path: '/styleguide', element: <Suspense fallback={<PageSkeleton />}><StyleGuide /></Suspense> },
  { path: '/', element: <Layout><Dashboard /></Layout> },
  { path: '/properties', element: <Layout><PropertiesList /></Layout> },
  { path: '/properties/new', element: <Layout><PropertyForm /></Layout> },
  { path: '/properties/:id/edit', element: <Layout><PropertyForm /></Layout> },
  { path: '/properties/:id', element: <Layout><PropertyDetail /></Layout> },
  { path: '/tenants', element: <Layout><TenantsList /></Layout> },
  { path: '/tenants/new', element: <Layout><TenantForm /></Layout> },
  { path: '/tenants/:id/edit', element: <Layout><TenantForm /></Layout> },
  { path: '/tenants/:id', element: <Layout><TenantDetail /></Layout> },
  { path: '/leases', element: <Layout><LeasesList /></Layout> },
  { path: '/leases/new', element: <Layout><LeaseForm /></Layout> },
  { path: '/leases/intake', element: <Layout><LeaseIntake /></Layout> },
  { path: '/leases/:id', element: <Layout><LeaseDetail /></Layout> },
  { path: '/billing', element: <Layout><BillingDashboard /></Layout> },
  { path: '/ar', element: <Layout><ARDashboard /></Layout> },
  { path: '/critical-dates', element: <Layout><CriticalDatesFeed /></Layout> },
  { path: '/exports', element: <Layout><QBExport /></Layout> },
  { path: '/payments',  element: <Layout><PaymentsList /></Layout> },
  { path: '/cam',       element: <Layout><CAMList /></Layout> },
  { path: '/expenses',  element: <Layout><ExpensesList /></Layout> },
  { path: '/budgets',   element: <Layout><BudgetsList /></Layout> },
  { path: '/renewals',  element: <Layout><RenewalsPipeline /></Layout> },
  { path: '/insurance', element: <Layout><InsuranceList /></Layout> },
  { path: '/insurance/new', element: <Layout><InsuranceForm /></Layout> },
  { path: '/units', element: <Layout><UnitsPage /></Layout> },
  { path: '/rent-roll', element: <Layout><RentRoll /></Layout> },
  { path: '/portal/*', element: <Suspense fallback={<PageSkeleton />}><PortalApp /></Suspense> },
  { path: '/portal', element: <Suspense fallback={<PageSkeleton />}><PortalApp /></Suspense> },
])
