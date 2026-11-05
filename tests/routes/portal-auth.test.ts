import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createApp } from '../../server/index'
import { portalAuthRouter } from '../../server/routes/portal-auth'

const mockFrom = vi.hoisted(() => vi.fn())
const mockInviteUserByEmail = vi.hoisted(() => vi.fn())
const mockDeleteUser = vi.hoisted(() => vi.fn())
const mockGetUser = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockImplementation((_url: string, key: string) => {
    // Service-role client (admin ops + adminAuthMiddleware token verification)
    if (key === 'test') {
      return {
        from: mockFrom,
        auth: {
          getUser: mockGetUser,
          admin: {
            inviteUserByEmail: mockInviteUserByEmail,
            deleteUser: mockDeleteUser,
          },
        },
      }
    }
    // Should not be called with other keys in tests
    return { from: mockFrom }
  }),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  CRON_SECRET: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  ADMIN_EMAILS: 'ggoldberg@oxfordra.net',
}

// /api/admin is gated by adminAuthMiddleware: requests must carry a Bearer token
// that resolves to an ADMIN_EMAILS-allowlisted user (OI-036) who is not also a tenant.
const AUTH = { Authorization: 'Bearer admin-token' }

// adminAuthMiddleware ALSO queries the `tenants` table (its tenant-exclusion check,
// OI-036) on every request that passes the email-allowlist check — through the same
// mockFrom this file's own handler-level tenant lookups use. Both call `.from('tenants')`,
// so this helper differentiates by the `.eq()` column: the middleware always queries
// `auth_user_id` (and expects nobody to match — these tests' admin is never a tenant),
// while portal-auth.ts's own handlers query by `id`. P1 T12: the middleware then reads
// `admin_users` by `email` (role data model, recorded not enforced) through the same
// mockFrom, chaining .abortSignal() before .maybeSingle() — answered with "no row"
// (adminRole null, adminRoleSource 'none'; access unchanged).
function mockTenantsTable(byIdResult: { data: unknown; error: unknown }, opts?: {
  update?: ReturnType<typeof vi.fn>
}) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn((column: string) => {
        if (column === 'auth_user_id' || column === 'email') {
          const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
          return { maybeSingle, abortSignal: vi.fn().mockReturnValue({ maybeSingle }) }
        }
        return { single: vi.fn().mockResolvedValue(byIdResult) }
      }),
    }),
    update: opts?.update ?? vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
  }
}

const app = createApp()

beforeEach(() => {
  vi.clearAllMocks()
  // Default to a valid ORA admin; auth-gate tests override this.
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'admin_1', email: 'ggoldberg@oxfordra.net' } },
    error: null,
  })
})

describe('POST /api/admin/tenants/:id/invite', () => {
  it('invites tenant and stores auth_user_id', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({
      data: { id: 'tenant_1', contact_email: 'tenant@example.com', auth_user_id: null },
      error: null,
    }))
    mockInviteUserByEmail.mockResolvedValue({
      data: { user: { id: 'auth_user_new' } },
      error: null,
    })

    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { invited: boolean; auth_user_id: string }
    expect(body.invited).toBe(true)
    expect(body.auth_user_id).toBe('auth_user_new')
  })

  it('returns 409 if tenant already has portal access', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({
      data: { id: 'tenant_1', contact_email: 'tenant@example.com', auth_user_id: 'existing_id' },
      error: null,
    }))

    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(409)
  })

  it('returns 404 if tenant not found', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({ data: null, error: { message: 'not found' } }))

    const res = await app.request('/api/admin/tenants/bad_id/invite', {
      method: 'POST',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(404)
  })

  it('returns 400 if tenant has no contact_email', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({
      data: { id: 'tenant_1', contact_email: null, auth_user_id: null },
      error: null,
    }))

    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(400)
  })

  // OI-063 (OI-042's self-flagged 5-file gap): the invite call's error was
  // returned raw (inviteErr.message) to the client — a Supabase Auth Admin
  // API error, same disclosure risk class as a raw Postgres error. Fixed via
  // the dbError() helper.
  it('returns a generic 500 message, never the raw Supabase Auth error, if invite fails', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({
      data: { id: 'tenant_1', contact_email: 'tenant@example.com', auth_user_id: null },
      error: null,
    }))
    mockInviteUserByEmail.mockResolvedValue({
      data: null,
      error: { message: 'GoTrue instance misconfigured: SMTP relay rejected by internal-mail-01.oxfordra.net' },
    })

    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/GoTrue|SMTP|internal-mail-01/)
    expect(json.error).toBe('Failed to invite tenant')
  })
})

describe('DELETE /api/admin/tenants/:id/revoke-access', () => {
  it('revokes portal access', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({
      data: { auth_user_id: 'existing_auth_id' },
      error: null,
    }))
    mockDeleteUser.mockResolvedValue({ data: {}, error: null })

    const res = await app.request('/api/admin/tenants/tenant_1/revoke-access', {
      method: 'DELETE',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { revoked: boolean }
    expect(body.revoked).toBe(true)
    expect(mockDeleteUser).toHaveBeenCalledWith('existing_auth_id')
  })

  it('returns 404 if tenant has no portal access to revoke', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({ data: { auth_user_id: null }, error: null }))

    const res = await app.request('/api/admin/tenants/tenant_1/revoke-access', {
      method: 'DELETE',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(404)
  })

  // OI-063 (OI-042's self-flagged 5-file gap): the delete call's error was
  // returned raw (deleteErr.message) to the client. Fixed via dbError().
  it('returns a generic 500 message, never the raw Supabase Auth error, if deleteUser fails', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({ data: { auth_user_id: 'existing_auth_id' }, error: null }))
    mockDeleteUser.mockResolvedValue({
      data: null,
      error: { message: 'auth.users row locked by concurrent admin session admin_7f3a' },
    })

    const res = await app.request('/api/admin/tenants/tenant_1/revoke-access', {
      method: 'DELETE',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).not.toMatch(/auth\.users|admin_7f3a/)
    expect(json.error).toBe('Failed to revoke portal access')
  })
})

describe('admin auth gate (security regression)', () => {
  // Full happy-path mocks: if the endpoint were NOT gated, these would 200.
  // The point is that auth must be enforced BEFORE the handler runs.
  function armInviteHappyPath() {
    mockFrom.mockReturnValue(mockTenantsTable({
      data: { id: 'tenant_1', contact_email: 'tenant@example.com', auth_user_id: null },
      error: null,
    }))
    mockInviteUserByEmail.mockResolvedValue({ data: { user: { id: 'auth_user_new' } }, error: null })
  }

  it('POST /invite is rejected with 401 when no Authorization header is sent', async () => {
    armInviteHappyPath()
    const res = await app.request('/api/admin/tenants/tenant_1/invite', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('DELETE /revoke-access is rejected with 401 when no Authorization header is sent', async () => {
    mockFrom.mockReturnValue(mockTenantsTable({ data: { auth_user_id: 'existing_auth_id' }, error: null }))
    mockDeleteUser.mockResolvedValue({ data: {}, error: null })

    const res = await app.request('/api/admin/tenants/tenant_1/revoke-access', { method: 'DELETE' }, env)
    expect(res.status).toBe(401)
  })

  it('POST /invite is rejected with 403 for an authenticated non-@oxfordra.net user', async () => {
    armInviteHappyPath()
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'intruder', email: 'attacker@gmail.com' } },
      error: null,
    })
    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
      headers: AUTH,
    }, env)
    expect(res.status).toBe(403)
  })

  // Defense in depth: the router must enforce auth itself, so it stays protected
  // even if it were ever mounted without (or wrongly exempted from) the
  // app-level admin gate in server/index.ts.
  it('portalAuthRouter self-gates when mounted without the app-level gate', async () => {
    // Happy-path mocks: an UNGATED router would reach the handler and 200.
    mockFrom.mockReturnValue(mockTenantsTable({
      data: { id: 'tenant_1', contact_email: 'tenant@example.com', auth_user_id: null },
      error: null,
    }))
    mockInviteUserByEmail.mockResolvedValue({ data: { user: { id: 'auth_user_new' } }, error: null })

    const bare = new Hono()
    bare.route('/api/admin', portalAuthRouter)
    const res = await bare.request('/api/admin/tenants/tenant_1/invite', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })
})
