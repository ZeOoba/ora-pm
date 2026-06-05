import { createClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'

type AdminEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

declare module 'hono' {
  interface ContextVariableMap {
    adminUserId: string
    adminEmail: string
  }
}

export async function adminAuthMiddleware(
  c: Context<{ Bindings: AdminEnv }>,
  next: Next
) {
  const authHeader = c.req.header('Authorization')
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!jwt) return c.json({ error: 'Missing Authorization header' }, 401)

  const supabase = createClient(
    c.env.SUPABASE_URL,
    c.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: { user }, error } = await supabase.auth.getUser(jwt)
  if (error || !user) return c.json({ error: 'Invalid or expired token' }, 401)

  if (!user.email?.endsWith('@oxfordra.net')) {
    return c.json({ error: 'Forbidden: admin access requires @oxfordra.net' }, 403)
  }

  c.set('adminUserId', user.id)
  c.set('adminEmail', user.email!)
  await next()
}
