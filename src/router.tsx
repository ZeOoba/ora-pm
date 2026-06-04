import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { Dashboard } from './pages/Dashboard'
import { PropertiesList } from './pages/properties/PropertiesList'

function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}

export const router = createBrowserRouter([
  { path: '/', element: <Layout><Dashboard /></Layout> },
  { path: '/properties', element: <Layout><PropertiesList /></Layout> },
  // Additional routes added as pages are built in subsequent tasks
])
