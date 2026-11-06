import { useState, useEffect } from 'react'
import { PortalRouter } from './PortalRouter'
import { portalSupabase } from './lib/supabase-portal'
import { checkAal2Guard, type AalGuardResult } from './lib/mfa-guard'
import { PortalMfaChallenge } from './components/PortalMfaChallenge'
import type { Session } from '@supabase/supabase-js'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/skeleton'

function PortalLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ivory p-6" aria-busy="true" aria-label="Loading">
      <div className="w-full max-w-sm space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    </div>
  )
}

export function PortalApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  // 'checking' until the first getAuthenticatorAssuranceLevel() call resolves for a
  // given session, so a tenant who needs a step-up never flashes into the router
  // before the guard has had a chance to say so. 'error' is distinct from 'checking'
  // so a failed check (network blip, Supabase outage) surfaces an actionable message
  // instead of hanging on the spinner forever -- and, like 'checking', it never falls
  // through to <PortalRouter, so the guard fails closed on error.
  const [aalStatus, setAalStatus] = useState<AalGuardResult | 'checking' | 'error'>('checking')
  const [aalRetryKey, setAalRetryKey] = useState(0)

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
    setAalStatus('checking')
    async function checkAal() {
      try {
        const { data, error } = await portalSupabase.auth.mfa.getAuthenticatorAssuranceLevel()
        if (cancelled) return
        if (error) throw error
        // Supabase types currentLevel/nextLevel as an open string (room for future AAL
        // values); today it only ever emits 'aal1' | 'aal2' | null, which is what the
        // pure guard's narrower type expects.
        setAalStatus(
          checkAal2Guard({
            currentLevel: (data?.currentLevel ?? null) as 'aal1' | 'aal2' | null,
            nextLevel: (data?.nextLevel ?? null) as 'aal1' | 'aal2' | null,
          })
        )
      } catch {
        // Fail closed: an error here must NOT be treated as "AAL check passed" --
        // it blocks access with an actionable message + retry (below), same as
        // 'checking' blocks it while pending. Never falls through to <PortalRouter.
        if (cancelled) return
        setAalStatus('error')
      }
    }
    checkAal()
    return () => {
      cancelled = true
    }
  }, [session, aalRetryKey])

  if (session === undefined) return <PortalLoading />

  if (session && aalStatus === 'checking') return <PortalLoading />

  if (session && aalStatus === 'error') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen text-status-neutral gap-3">
        <p role="alert" className="text-status-danger text-sm">Unable to verify your account's security status. Please try again.</p>
        <Button variant="ghost" className="border border-border" onClick={() => setAalRetryKey(k => k + 1)}>
          Try again
        </Button>
      </div>
    )
  }

  if (session && aalStatus === 'challenge required') {
    return <PortalMfaChallenge onVerified={() => setAalStatus('session OK')} />
  }

  return <PortalRouter session={session} />
}
