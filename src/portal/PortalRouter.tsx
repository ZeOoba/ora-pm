import { Routes, Route, Navigate } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { PortalLogin } from './pages/PortalLogin'
import { PortalDashboard } from './pages/PortalDashboard'
import { PortalPayNow } from './pages/PortalPayNow'
import { PortalPaymentHistory } from './pages/PortalPaymentHistory'
import { PortalMyLease } from './pages/PortalMyLease'
import { PortalDocuments } from './pages/PortalDocuments'
import { PortalInsurance } from './pages/PortalInsurance'
import { PortalAccount } from './pages/PortalAccount'
import { PortalShell } from './components/PortalShell'

interface Props { session: Session | null }

function PrivateRoute({ session, children }: { session: Session | null; children: React.ReactNode }) {
  if (!session) return <Navigate to="/portal/login" replace />
  return <>{children}</>
}

export function PortalRouter({ session }: Props) {
  return (
    <Routes>
      <Route path="login" element={<PortalLogin />} />
      <Route path="*" element={
        <PrivateRoute session={session}>
          <PortalShell session={session!}>
            <Routes>
              <Route index element={<PortalDashboard />} />
              <Route path="pay" element={<PortalPayNow />} />
              <Route path="payments" element={<PortalPaymentHistory />} />
              <Route path="lease" element={<PortalMyLease />} />
              <Route path="documents" element={<PortalDocuments />} />
              <Route path="insurance" element={<PortalInsurance />} />
              <Route path="account" element={<PortalAccount />} />
            </Routes>
          </PortalShell>
        </PrivateRoute>
      } />
    </Routes>
  )
}
