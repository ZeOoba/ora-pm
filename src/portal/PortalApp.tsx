import { useState, useEffect } from 'react'
import { PortalRouter } from './PortalRouter'
import { portalSupabase } from './lib/supabase-portal'
import type { Session } from '@supabase/supabase-js'

export function PortalApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    portalSupabase.auth.getSession().then(({ data: { session } }) => setSession(session))
    const { data: { subscription } } = portalSupabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return <div className="flex items-center justify-center min-h-screen text-gray-500">Loading…</div>

  return <PortalRouter session={session} />
}
