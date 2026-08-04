import { useState } from 'react'
import { portalSupabase } from '../lib/supabase-portal'

interface Props {
  onVerified: () => void
}

// Rendered by PortalApp in place of the router when checkAal2Guard (lib/mfa-guard.ts)
// says the session hasn't cleared its verified TOTP factor yet (OI-045). Challenges
// the tenant's existing verified factor and verifies the code -- this is the AAL2
// step-up, not enrollment (that's PortalAccount's modal).
export function PortalMfaChallenge({ onVerified }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { data: factorsData, error: factorsError } = await portalSupabase.auth.mfa.listFactors()
      if (factorsError) throw factorsError
      // Only ever challenge a verified factor -- matching PortalAccount.tsx's
      // loadFactors filter. An unfiltered [0] pick could target a stale/orphaned
      // unverified factor (e.g. a second tab open mid-enrollment) instead of the
      // tenant's actual authenticator, on the real security step-up screen.
      const verifiedFactors = factorsData?.totp?.filter(f => f.status === 'verified') ?? []
      const factor = verifiedFactors[0]
      if (!factor) throw new Error('No verified authenticator found for this account')

      const { data: challengeData, error: challengeError } = await portalSupabase.auth.mfa.challenge({
        factorId: factor.id,
      })
      if (challengeError) throw challengeError

      const { error: verifyError } = await portalSupabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challengeData.id,
        code,
      })
      if (verifyError) throw verifyError

      onVerified()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white shadow rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-[#1B2A4A] mb-1">Verify it's you</h1>
        <p className="text-gray-500 text-sm mb-6">Enter the 6-digit code from your authenticator app.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            inputMode="numeric"
            required
            value={code}
            onChange={e => setCode(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="123456"
          />
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-[#1B2A4A] text-white rounded px-4 py-2 text-sm font-medium hover:bg-[#243660] disabled:opacity-50"
          >
            Verify
          </button>
        </form>
      </div>
    </div>
  )
}
