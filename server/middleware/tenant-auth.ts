import { createClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'

type TenantEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

declare module 'hono' {
  interface ContextVariableMap {
    tenantUserId: string
  }
}

export async function tenantAuthMiddleware(c: Context<{ Bindings: TenantEnv }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!jwt) return c.json({ error: 'Missing Authorization header' }, 401)

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: { user }, error } = await supabase.auth.getUser(jwt)
  if (error || !user) return c.json({ error: 'Invalid or expired token' }, 401)

  c.set('tenantUserId', user.id)
  await next()
}
