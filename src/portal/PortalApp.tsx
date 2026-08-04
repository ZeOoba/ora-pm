import { useState, useEffect } from 'react'
import { PortalRouter } from './PortalRouter'
import { portalSupabase } from './lib/supabase-portal'
import { checkAal2Guard, type AalGuardResult } from './lib/mfa-guard'
import { PortalMfaChallenge } from './components/PortalMfaChallenge'
import type { Session } from '@supabase/supabase-js'

export function PortalApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  // 'checking' until the first getAuthenticatorAssuranceLevel() call resolves for a
  // given session, so a tenant who needs a step-up never flashes into the router
  // before the guard has had a chance to say so.
  const [aalStatus, setAalStatus] = useState<AalGuardResult | 'checking'>('checking')

  useEffect(() => {
    portalSupabase.auth.getSession().then(({ data: { session } }) => setSession(session))
    const { data: { subscription } } = portalSupabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  // AAL2 guard (OI-045): thin call site around the pure checkAal2Guard decision in
  // lib/mfa-guard.ts. A tenant with a verified TOTP factor whose current session
  // hasn't cleared an MFA challenge gets routed to PortalMfaChallenge instead of the
  // app; a tenant with no verified factor is unaffected.
  useEffect(() => {
    if (!session) {
      setAalStatus('checking')
      return
    }
    let cancelled = false
    portalSupabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => {
      if (cancelled) return
      // Supabase types currentLevel/nextLevel as an open string (room for future AAL
      // values); today it only ever emits 'aal1' | 'aal2' | null, which is what the
      // pure guard's narrower type expects.
      setAalStatus(
        checkAal2Guard({
          currentLevel: (data?.currentLevel ?? null) as 'aal1' | 'aal2' | null,
          nextLevel: (data?.nextLevel ?? null) as 'aal1' | 'aal2' | null,
        })
      )
    })
    return () => {
      cancelled = true
    }
  }, [session])

  if (session === undefined) return <div className="flex items-center justify-center min-h-screen text-gray-500">Loading…</div>

  if (session && aalStatus === 'checking') return <div className="flex items-center justify-center min-h-screen text-gray-500">Loading…</div>

  if (session && aalStatus === 'challenge required') {
    return <PortalMfaChallenge onVerified={() => setAalStatus('session OK')} />
  }

  return <PortalRouter session={session} />
}
