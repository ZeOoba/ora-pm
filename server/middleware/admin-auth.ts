import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'
import { isAdminRole, type AdminRole } from '../lib/admin-roles'

type AdminEnv = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  ADMIN_EMAILS?: string // comma-separated exact-match allowlist; never a domain-suffix check
}

declare module 'hono' {
  interface ContextVariableMap {
    adminUserId: string
    adminEmail: string
    // P1 T12: recorded, NOT enforced (see lookupAdminRole). null = UNKNOWN; unset on routes this
    // middleware did not run on. Future enforcement must treat both as deny.
    adminRole: AdminRole | null
    adminEntityScope: string[] | null
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
  const { data: tenantRow, error: tenantLookupError } = await supabase
    .from('tenants')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  // Fail CLOSED: a query failure (network blip, RLS misconfiguration, transient
  // outage) must not silently degrade into "no tenant row found" — that would
  // skip the tenant-exclusion check entirely and let the request through.
  if (tenantLookupError) {
    return c.json({ error: 'Unable to verify account type' }, 500)
  }
  if (tenantRow) {
    return c.json({ error: 'Forbidden: tenant accounts cannot access admin routes' }, 403)
  }

  c.set('adminUserId', user.id)
  c.set('adminEmail', user.email)

  // P1 T12: admin role DATA MODEL — recorded on the context, NOT enforced (no route reads it yet).
  // It runs only after every check above has passed, and ADMIN_EMAILS stays the sole authority
  // for admin access: an admin_users row cannot admit a non-allowlisted email or a tenant, because
  // those requests were rejected above and this table is never read for them. Whatever the
  // lookup returns, the request proceeds — the access decision is unchanged in P1.
  //
  // FUTURE ENFORCEMENT MUST FAIL CLOSED: treat adminRole === null (UNKNOWN: the lookup failed or
  // the stored row did not validate) and an unset adminRole (this middleware did not run) as
  // DENY. Never coalesce null to 'owner'.
  const { role, entityScope } = await lookupAdminRole(supabase, user.email.toLowerCase())
  c.set('adminRole', role)
  c.set('adminEntityScope', entityScope)
  await next()
}

type AdminRoleLookup = { role: AdminRole | null; entityScope: string[] | null }

// row found -> its role and entity_scope
// no row    -> 'owner', null scope (the legacy single-admin behaviour; no seed rows exist)
// error     -> null, null (UNKNOWN) plus a server-side warning. Covers a PostgREST error
//              (including admin_users not existing yet because 0018 is unapplied: 42P01 /
//              PGRST205), a thrown client error, and a stored row that fails validation.
// Never throws, so the role lookup can neither grant nor deny access. One round trip: emails are
// stored lower-cased (0018 CHECK) and the caller passes the lower-cased auth email.
async function lookupAdminRole(supabase: SupabaseClient, email: string): Promise<AdminRoleLookup> {
  const unknown = (reason: string, ...detail: unknown[]): AdminRoleLookup => {
    // No email, user id or token in the log line — the same hygiene as the AAL and DB error logs.
    console.warn(`[ORA PM] admin_users role lookup failed (${reason}); adminRole=null (UNKNOWN), access unchanged`, ...detail)
    return { role: null, entityScope: null }
  }
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('role, entity_scope')
      .eq('email', email)
      .maybeSingle()
    if (error) return unknown('query error', error.code, error.message)
    if (!data) return { role: 'owner', entityScope: null }
    // Validate the whole row. A valid role with an unreadable scope must not be recorded as
    // unscoped — that would widen the admin's reach the day scopes are enforced.
    const entityScope: unknown = data.entity_scope ?? null
    if (!isAdminRole(data.role)) return unknown('unrecognized role')
    if (!isEntityScope(entityScope)) return unknown('malformed entity_scope')
    return { role: data.role, entityScope }
  } catch (err) {
    return unknown('lookup threw', err instanceof Error ? err.message : String(err))
  }
}

function isEntityScope(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.every((id) => typeof id === 'string'))
}
