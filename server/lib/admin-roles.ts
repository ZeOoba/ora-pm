// P1 T12 (roadmap G10): the admin role vocabulary — a DATA MODEL, not yet an authorization model.
//
// server/middleware/admin-auth.ts records each admin's role on the request context as
// `adminRole` / `adminEntityScope` / `adminRoleSource`, read from the admin_users table
// (supabase/migrations/0018_admin_roles.sql). Nothing enforces a role in P1: the ADMIN_EMAILS
// allowlist remains the sole authority for admin access. Role enforcement lands in a later phase.
//
// ADMIN_ROLES MUST mirror the admin_users.role CHECK in the migrations — change both in the same PR
// (tests/lib/admin-roles.test.ts fails on drift).
//
// For whoever adds enforcement (P3):
//   * `adminRole` is null when the admin has no admin_users row (adminRoleSource 'none') or the
//     lookup failed (adminRoleSource 'error'), and undefined on routes the admin middleware never
//     ran on. Treat null AND undefined as DENY (fail closed); never coalesce either to a role.
//   * Seed one admin_users row per ADMIN_EMAILS entry BEFORE enforcing: an allowlisted admin with
//     no row has no role, so enforcing first would lock every admin out.
export const ADMIN_ROLES = ['owner', 'manager', 'bookkeeper', 'viewer'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

// Where adminRole came from. Only 'row' carries a role (and a scope):
//   'row'   a stored admin_users row with a recognized role and a well-formed entity_scope
//   'none'  the lookup succeeded and there is no row for this email
//   'error' the lookup failed or timed out, or the stored row did not validate
export type AdminRoleSource = 'row' | 'none' | 'error'

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value)
}
