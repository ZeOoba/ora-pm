import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'

export function AdminAuthGuard({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | 'loading'>('loading')
  const navigate = useNavigate()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) navigate('/login', { replace: true })
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) navigate('/login', { replace: true })
    })
    return () => subscription.unsubscribe()
  }, [navigate])

  if (session === 'loading') {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400 text-sm">
        Loading…
      </div>
    )
  }
  if (!session) return null
  return <>{children}</>
}
