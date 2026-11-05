/// <reference types="node" />
// tests/lib/admin-roles.test.ts
//
// P1 T12: the admin role vocabulary. server/lib/admin-roles.ts is what the middleware validates a
// stored admin_users.role against, and what later phases will enforce on — so it must never drift
// from the database CHECK that constrains the column.
import { describe, it, expect } from 'vitest'
import { allMigrationText } from '../fixtures/pg-migrations'
import { ADMIN_ROLES, isAdminRole } from '../../server/lib/admin-roles'

describe('admin role vocabulary (T12)', () => {
  it('is exactly owner, manager, bookkeeper, viewer', () => {
    expect([...ADMIN_ROLES]).toEqual(['owner', 'manager', 'bookkeeper', 'viewer'])
  })

  it('mirrors the admin_users.role CHECK in the migrations (drift tripwire)', () => {
    // The LAST definition across all migrations wins, so a later migration that changes the CHECK
    // is compared here too — update ADMIN_ROLES in the same PR.
    const defs = [...allMigrationText().matchAll(/admin_users_role_check CHECK \(role IN \(([^)]*)\)\)/g)]
    expect(defs.length).toBeGreaterThan(0)
    const dbRoles = defs[defs.length - 1][1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(dbRoles).toEqual([...ADMIN_ROLES])
  })

  it('isAdminRole accepts each role', () => {
    for (const role of ADMIN_ROLES) expect(isAdminRole(role)).toBe(true)
  })

  it('isAdminRole rejects anything else — case variants, padding, blanks and non-strings', () => {
    for (const value of ['admin', 'Owner', 'OWNER', ' owner', 'owner ', '', null, undefined, 0, 1, true, {}, [], ['owner']]) {
      expect(isAdminRole(value), JSON.stringify(value) ?? String(value)).toBe(false)
    }
  })
})
