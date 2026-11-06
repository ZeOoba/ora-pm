import { useState } from 'react'
import { portalSupabase } from '../lib/supabase-portal'
import { Button } from '../../components/ui/Button'

export function PortalLogin() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const { error } = await portalSupabase.auth.signInWithOtp({
      email,
      // OI-080: tenant accounts are provisioned exclusively via portal-auth.ts's
      // inviteUserByEmail — this call must never self-provision a new auth user
      // (mirrors AdminLogin.tsx's OI-036 fix).
      options: { emailRedirectTo: window.location.origin + '/portal', shouldCreateUser: false },
    })
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ivory">
      <div className="bg-white shadow rounded-lg p-8 w-full max-w-sm">
        <h1 className="font-display text-2xl text-navy mb-1">Tenant Portal</h1>
        <p className="text-status-neutral text-sm mb-6">Oxford Realty Advisors</p>

        {sent ? (
          <div className="text-status-active bg-status-active/5 rounded p-4 text-sm">
            Check your email for a sign-in link. You can close this tab.
          </div>
        ) : (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-navy mb-1">Email address</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border border-navy/15 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                placeholder="you@company.com"
              />
            </div>
            {error && <p role="alert" className="text-status-danger text-sm">{error}</p>}
            <Button type="submit" className="w-full">
              Send sign-in link
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
