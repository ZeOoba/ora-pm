import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'
import { isAdminRole, type AdminRole, type AdminRoleSource } from '../lib/admin-roles'

type AdminEnv = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  ADMIN_EMAILS?: string // comma-separated exact-match allowlist; never a domain-suffix check
}

declare module 'hono' {
  interface ContextVariableMap {
    adminUserId: string
    adminEmail: string
    // P1 T12: recorded, NOT enforced (see lookupAdminRole). null = no role (no row, or the lookup
    // failed: adminRoleSource says which); undefined on routes this middleware did not run on
    // (ADMIN_EXEMPT in server/index.ts), so every reader must handle it. Future enforcement must
    // treat null AND undefined as deny.
    adminRole: AdminRole | null | undefined
    adminEntityScope: string[] | null | undefined
    adminRoleSource: AdminRoleSource | undefined
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
  // lookup returns — and it always settles within ROLE_LOOKUP_TIMEOUT_MS — the request proceeds:
  // the access decision is unchanged in P1.
  //
  // FUTURE ROLE ENFORCEMENT MUST FAIL CLOSED:
  //   * treat adminRole null (no row, or the lookup failed) AND undefined (this middleware did not
  //     run) as DENY; never coalesce either to a role;
  //   * P3 must seed one admin_users row per ADMIN_EMAILS entry BEFORE enforcing: an allowlisted
  //     admin with no row has no role, so enforcing first would lock every admin out.
  const lookup = await lookupAdminRole(supabase, user.email.toLowerCase())
  c.set('adminRole', lookup.role)
  c.set('adminEntityScope', lookup.entityScope)
  c.set('adminRoleSource', lookup.source)
  await next()
}

// Upper bound on the admin_users role lookup. It runs on every admin-gated request but decides
// nothing in P1, so a stalled query (e.g. waiting on a lock held by a future ALTER TABLE) must not
// stall the request: past this bound the query is aborted and the lookup reports source 'error'.
export const ROLE_LOOKUP_TIMEOUT_MS = 1500

// Only a validated row carries a role and a scope; every other outcome carries neither.
type AdminRoleLookup =
  | { source: 'row'; role: AdminRole; entityScope: string[] | null }
  | { source: 'none' | 'error'; role: null; entityScope: null }

const TIMED_OUT = Symbol('admin_users role lookup timed out')

// row with a recognized role and a well-formed scope -> 'row': its role, entity_scope ?? null
// no row (data === null, no error)                   -> 'none': null, null; not logged
// anything else                                      -> 'error': null, null, one warning. That is
//   a PostgREST error (including admin_users not existing yet because 0018 is unapplied: 42P01 /
//   PGRST205), a thrown or rejected client call, no answer within ROLE_LOOKUP_TIMEOUT_MS (the
//   query is aborted), a malformed result, an unrecognized role, or a malformed entity_scope.
// Never throws and always settles within the bound, so the role lookup can neither grant access,
// deny it, nor hold the request. One round trip: emails are stored lower-cased and trimmed (0018
// CHECKs) and the caller passes the lower-cased auth email.
async function lookupAdminRole(supabase: SupabaseClient, email: string): Promise<AdminRoleLookup> {
  const failed = (reason: string, ...detail: string[]): AdminRoleLookup => {
    // No email, user id or token in the log line — the same hygiene as the AAL and DB error logs.
    // Every argument is a plain string, so logging cannot throw either.
    console.warn(
      `[ORA PM] admin_users role lookup failed (${reason}); adminRole=null, adminRoleSource=error, access unchanged`,
      ...detail,
    )
    return { source: 'error', role: null, entityScope: null }
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT)
        controller.abort()
      }, ROLE_LOOKUP_TIMEOUT_MS)
    })
    const query = supabase
      .from('admin_users')
      .select('role, entity_scope')
      .eq('email', email)
      .abortSignal(controller.signal)
      .maybeSingle()
    const result = await Promise.race([query, timedOut])
    if (result === TIMED_OUT) return failed(`timed out after ${ROLE_LOOKUP_TIMEOUT_MS} ms; query aborted`)
    const { data, error } = result
    if (error) return failed('query error', describeSafely(error.code), describeSafely(error.message))
    if (data === null) return { source: 'none', role: null, entityScope: null }
    if (typeof data !== 'object') return failed('malformed result')
    // Validate the whole row. A valid role with an unreadable scope must not be recorded as
    // unscoped — that would widen the admin's reach the day scopes are enforced.
    const entityScope: unknown = data.entity_scope ?? null
    if (!isAdminRole(data.role)) return failed('unrecognized role')
    if (!isEntityScope(entityScope)) return failed('malformed entity_scope')
    return { source: 'row', role: data.role, entityScope }
  } catch (err) {
    return failed('lookup threw', describeSafely(err))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isEntityScope(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.every((id) => typeof id === 'string'))
}

// Renders a thrown value or an error field for the log line and never throws itself: String()
// throws on a null-prototype object or a hostile toString, and a throw escaping the catch above
// would turn a failed role lookup into a 500, i.e. deny access.
function describeSafely(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '[unprintable value]'
  }
}
