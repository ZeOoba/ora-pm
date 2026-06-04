import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { PropertiesList } from './pages/properties/PropertiesList'
import { TenantsList } from './pages/tenants/TenantsList'
import { LeasesList } from './pages/leases/LeasesList'
import { LeaseDetail } from './pages/leases/LeaseDetail'

function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}

export const router = createBrowserRouter([
  { path: '/', element: <Layout><Dashboard /></Layout> },
  { path: '/properties', element: <Layout><PropertiesList /></Layout> },
  { path: '/tenants', element: <Layout><TenantsList /></Layout> },
  { path: '/leases', element: <Layout><LeasesList /></Layout> },
  { path: '/leases/:id', element: <Layout><LeaseDetail /></Layout> },
  // Additional routes added as pages are built in subsequent tasks
])
