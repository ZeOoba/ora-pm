import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button } from '../../components/ui/Button'

export function AdminLogin() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.endsWith('@oxfordra.net')) {
      setError('Admin access requires an @oxfordra.net email address.')
      return
    }
    setLoading(true)
    setError('')
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      // OI-036: admin accounts must be pre-created in the Supabase dashboard and added
      // to ADMIN_EMAILS — this call must never self-provision a new auth user.
      options: { emailRedirectTo: window.location.origin, shouldCreateUser: false },
    })
    setLoading(false)
    if (err) { setError(err.message); return }
    setSent(true)
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-muted">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-sm border border-border p-8">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Oxford Realty</p>
        <h1 className="text-xl font-bold text-foreground mt-1 mb-6">Property Manager</h1>

        {sent ? (
          <div className="text-sm text-status-active bg-status-active/10 border border-status-active/30 rounded p-4">
            Check your email — a magic link has been sent to <strong>{email}</strong>.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@oxfordra.net"
                required
                className="w-full rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {error && <p className="text-sm text-status-danger">{error}</p>}
            <Button type="submit" variant="navy" disabled={loading} className="w-full">
              {loading ? 'Sending…' : 'Send Magic Link'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
