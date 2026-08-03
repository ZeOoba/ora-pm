import { createClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'

type AdminEnv = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  ADMIN_EMAILS?: string // comma-separated exact-match allowlist; never a domain-suffix check
}

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

  // OI-036: explicit allowlist replaces the old @oxfordra.net domain-suffix check — one
  // Supabase auth project serves both admin and tenant audiences, so a tenant invited
  // with an @oxfordra.net contact email would otherwise also pass. Fail-CLOSED: never
  // authorize admin access with no allowlist configured (mirrors the confidentiality
  // denylist pattern at server/routes/intake.ts:23-27).
  const adminEmails = (c.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  if (adminEmails.length === 0) {
    return c.json({ error: 'Admin access is disabled: ADMIN_EMAILS is not configured.' }, 503)
  }

  const supabase = createClient(
    c.env.SUPABASE_URL,
    c.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: { user }, error } = await supabase.auth.getUser(jwt)
  if (error || !user) return c.json({ error: 'Invalid or expired token' }, 401)

  if (!user.email || !adminEmails.includes(user.email.toLowerCase())) {
    return c.json({ error: 'Forbidden: admin access requires an allowlisted email' }, 403)
  }

  // Closes the case where an allowlisted admin email is also, somehow, a tenant's
  // contact — and more importantly closes the case where a non-allowlisted tenant
  // address would otherwise have passed a looser check.
  const { data: tenantRow } = await supabase
    .from('tenants')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (tenantRow) {
    return c.json({ error: 'Forbidden: tenant accounts cannot access admin routes' }, 403)
  }

  c.set('adminUserId', user.id)
  c.set('adminEmail', user.email)
  await next()
}
