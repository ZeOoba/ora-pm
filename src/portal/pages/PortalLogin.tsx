import { useState } from 'react'
import { portalSupabase } from '../lib/supabase-portal'

export function PortalLogin() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const { error } = await portalSupabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + '/portal' },
    })
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white shadow rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-[#1B2A4A] mb-1">Tenant Portal</h1>
        <p className="text-gray-500 text-sm mb-6">Oxford Realty Advisors</p>

        {sent ? (
          <div className="text-green-700 bg-green-50 rounded p-4 text-sm">
            Check your email for a sign-in link. You can close this tab.
          </div>
        ) : (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="you@company.com"
              />
            </div>
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <button
              type="submit"
              className="w-full bg-[#1B2A4A] text-white rounded px-4 py-2 text-sm font-medium hover:bg-[#243660]"
            >
              Send sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
