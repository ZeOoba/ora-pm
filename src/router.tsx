import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { PropertiesList } from './pages/properties/PropertiesList'
import { PropertyForm } from './pages/properties/PropertyForm'
import { PropertyDetail } from './pages/properties/PropertyDetail'
import { TenantsList } from './pages/tenants/TenantsList'
import { LeasesList } from './pages/leases/LeasesList'
import { LeaseDetail } from './pages/leases/LeaseDetail'
import { BillingDashboard } from './pages/billing/BillingDashboard'
import { ARDashboard } from './pages/ar/ARDashboard'
import { CriticalDatesFeed } from './pages/critical-dates/CriticalDatesFeed'
import { QBExport } from './pages/exports/QBExport'
import { PaymentsList }     from './pages/payments/PaymentsList'
import { CAMList }          from './pages/cam/CAMList'
import { ExpensesList }     from './pages/expenses/ExpensesList'
import { BudgetsList }      from './pages/budgets/BudgetsList'
import { RenewalsPipeline } from './pages/renewals/RenewalsPipeline'
import { InsuranceList }    from './pages/insurance/InsuranceList'

function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}

export const router = createBrowserRouter([
  { path: '/', element: <Layout><Dashboard /></Layout> },
  { path: '/properties', element: <Layout><PropertiesList /></Layout> },
  { path: '/properties/new', element: <Layout><PropertyForm /></Layout> },
  { path: '/properties/:id/edit', element: <Layout><PropertyForm /></Layout> },
  { path: '/properties/:id', element: <Layout><PropertyDetail /></Layout> },
  { path: '/tenants', element: <Layout><TenantsList /></Layout> },
  { path: '/leases', element: <Layout><LeasesList /></Layout> },
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
])
