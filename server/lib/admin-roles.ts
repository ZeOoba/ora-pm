// P1 T12 (roadmap G10): the admin role vocabulary — a DATA MODEL, not yet an authorization model.
//
// server/middleware/admin-auth.ts records each admin's role on the request context as
// `adminRole` / `adminEntityScope`, read from the admin_users table
// (supabase/migrations/0018_admin_roles.sql). Nothing enforces a role in P1: the ADMIN_EMAILS
// allowlist remains the sole authority for admin access. Role enforcement lands in a later phase.
//
// ADMIN_ROLES MUST mirror the admin_users.role CHECK in the migrations — change both in the same PR
// (tests/lib/admin-roles.test.ts fails on drift).
//
// For whoever adds enforcement: `adminRole` is null when the role is UNKNOWN (the admin_users
// lookup failed, or the stored row did not validate), and unset entirely on routes the admin
// middleware never ran on. Both MUST be treated as deny (fail closed) — never coalesce them to
// 'owner'. Only "no row at all" maps to 'owner', and that mapping happens in the middleware.
export const ADMIN_ROLES = ['owner', 'manager', 'bookkeeper', 'viewer'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value)
}
