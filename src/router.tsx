import { lazy, Suspense } from 'react'
import { createBrowserRouter } from 'react-router'
import { AppShell } from './components/AppShell'
import { AdminAuthGuard } from './components/AdminAuthGuard'
import { PageSkeleton } from './components/PageSkeleton'
import { AdminLogin } from './pages/auth/AdminLogin'
import { RouteError } from './components/RouteError'
import { ChunkLoadedMarker } from './components/ChunkLoadedMarker'

// Route-level code splitting: every page loads on demand; only AppShell, the auth guard, AdminLogin and RouteError stay eager.
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
const TransactionsPage = lazy(() => import('./pages/transactions/TransactionsPage').then((m) => ({ default: m.TransactionsPage })))
const ReportLibrary = lazy(() => import('./pages/reports/ReportLibrary').then((m) => ({ default: m.ReportLibrary })))
const FinancialReport = lazy(() => import('./pages/reports/FinancialReport').then((m) => ({ default: m.FinancialReport })))
const RentRoll = lazy(() => import('./pages/reports/RentRoll').then((m) => ({ default: m.RentRoll })))
const PaymentsList = lazy(() => import('./pages/payments/PaymentsList').then((m) => ({ default: m.PaymentsList })))
const CAMList = lazy(() => import('./pages/cam/CAMList').then((m) => ({ default: m.CAMList })))
const ExpensesList = lazy(() => import('./pages/expenses/ExpensesList').then((m) => ({ default: m.ExpensesList })))
const BudgetsList = lazy(() => import('./pages/budgets/BudgetsList').then((m) => ({ default: m.BudgetsList })))
const InsuranceList = lazy(() => import('./pages/insurance/InsuranceList').then((m) => ({ default: m.InsuranceList })))
const StyleGuide = lazy(() => import('./pages/StyleGuide').then((m) => ({ default: m.StyleGuide })))

// Layout is route glue local to this file; `router` (a non-component export) is the real export,
// so Fast Refresh already treats this module as non-refreshable — nothing to gain by splitting it.
// eslint-disable-next-line react-refresh/only-export-components
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AdminAuthGuard>
      <AppShell>
        <Suspense fallback={<PageSkeleton />}>
          {children}
          <ChunkLoadedMarker />
        </Suspense>
      </AppShell>
    </AdminAuthGuard>
  )
}

export const router = createBrowserRouter([
  { path: '/login', errorElement: <RouteError />, element: <AdminLogin /> },
  { path: '/styleguide', errorElement: <RouteError />, element: <Suspense fallback={<PageSkeleton />}><StyleGuide /></Suspense> },
  { path: '/', errorElement: <RouteError />, element: <Layout><Dashboard /></Layout> },
  { path: '/properties', errorElement: <RouteError />, element: <Layout><PropertiesList /></Layout> },
  { path: '/properties/new', errorElement: <RouteError />, element: <Layout><PropertyForm /></Layout> },
  { path: '/properties/:id/edit', errorElement: <RouteError />, element: <Layout><PropertyForm /></Layout> },
  { path: '/properties/:id', errorElement: <RouteError />, element: <Layout><PropertyDetail /></Layout> },
  { path: '/tenants', errorElement: <RouteError />, element: <Layout><TenantsList /></Layout> },
  { path: '/tenants/new', errorElement: <RouteError />, element: <Layout><TenantForm /></Layout> },
  { path: '/tenants/:id/edit', errorElement: <RouteError />, element: <Layout><TenantForm /></Layout> },
  { path: '/tenants/:id', errorElement: <RouteError />, element: <Layout><TenantDetail /></Layout> },
  { path: '/leases', errorElement: <RouteError />, element: <Layout><LeasesList /></Layout> },
  { path: '/leases/new', errorElement: <RouteError />, element: <Layout><LeaseForm /></Layout> },
  { path: '/leases/intake', errorElement: <RouteError />, element: <Layout><LeaseIntake /></Layout> },
  { path: '/leases/:id', errorElement: <RouteError />, element: <Layout><LeaseDetail /></Layout> },
  { path: '/billing', errorElement: <RouteError />, element: <Layout><BillingDashboard /></Layout> },
  { path: '/ar', errorElement: <RouteError />, element: <Layout><ARDashboard /></Layout> },
  { path: '/critical-dates', errorElement: <RouteError />, element: <Layout><CriticalDatesFeed /></Layout> },
  { path: '/exports', errorElement: <RouteError />, element: <Layout><QBExport /></Layout> },
  { path: '/payments',  errorElement: <RouteError />, element: <Layout><PaymentsList /></Layout> },
  { path: '/cam',       errorElement: <RouteError />, element: <Layout><CAMList /></Layout> },
  { path: '/expenses',  errorElement: <RouteError />, element: <Layout><ExpensesList /></Layout> },
  { path: '/budgets',   errorElement: <RouteError />, element: <Layout><BudgetsList /></Layout> },
  { path: '/renewals',  errorElement: <RouteError />, element: <Layout><RenewalsPipeline /></Layout> },
  { path: '/insurance', errorElement: <RouteError />, element: <Layout><InsuranceList /></Layout> },
  { path: '/insurance/new', errorElement: <RouteError />, element: <Layout><InsuranceForm /></Layout> },
  { path: '/units', errorElement: <RouteError />, element: <Layout><UnitsPage /></Layout> },
  { path: '/transactions', errorElement: <RouteError />, element: <Layout><TransactionsPage /></Layout> },
  { path: '/reports', errorElement: <RouteError />, element: <Layout><ReportLibrary /></Layout> },
  { path: '/reports/:kind', errorElement: <RouteError />, element: <Layout><FinancialReport /></Layout> },
  { path: '/rent-roll', errorElement: <RouteError />, element: <Layout><RentRoll /></Layout> },
  { path: '/portal/*', errorElement: <RouteError />, element: <Suspense fallback={<PageSkeleton />}><PortalApp /></Suspense> },
  { path: '/portal', errorElement: <RouteError />, element: <Suspense fallback={<PageSkeleton />}><PortalApp /></Suspense> },
])
