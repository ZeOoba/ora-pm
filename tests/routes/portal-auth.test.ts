import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../../server/index'

const mockFrom = vi.hoisted(() => vi.fn())
const mockInviteUserByEmail = vi.hoisted(() => vi.fn())
const mockDeleteUser = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockImplementation((_url: string, key: string) => {
    // Service-role client (used for admin ops)
    if (key === 'test') {
      return {
        from: mockFrom,
        auth: {
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
}

const app = createApp()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/admin/tenants/:id/invite', () => {
  it('invites tenant and stores auth_user_id', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'tenant_1', contact_email: 'tenant@example.com', auth_user_id: null },
            error: null,
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    })
    mockInviteUserByEmail.mockResolvedValue({
      data: { user: { id: 'auth_user_new' } },
      error: null,
    })

    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { invited: boolean; auth_user_id: string }
    expect(body.invited).toBe(true)
    expect(body.auth_user_id).toBe('auth_user_new')
  })

  it('returns 409 if tenant already has portal access', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'tenant_1', contact_email: 'tenant@example.com', auth_user_id: 'existing_id' },
            error: null,
          }),
        }),
      }),
    })

    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
    }, env)
    expect(res.status).toBe(409)
  })

  it('returns 404 if tenant not found', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
        }),
      }),
    })

    const res = await app.request('/api/admin/tenants/bad_id/invite', {
      method: 'POST',
    }, env)
    expect(res.status).toBe(404)
  })

  it('returns 400 if tenant has no contact_email', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'tenant_1', contact_email: null, auth_user_id: null },
            error: null,
          }),
        }),
      }),
    })

    const res = await app.request('/api/admin/tenants/tenant_1/invite', {
      method: 'POST',
    }, env)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/admin/tenants/:id/revoke-access', () => {
  it('revokes portal access', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { auth_user_id: 'existing_auth_id' },
            error: null,
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    })
    mockDeleteUser.mockResolvedValue({ data: {}, error: null })

    const res = await app.request('/api/admin/tenants/tenant_1/revoke-access', {
      method: 'DELETE',
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { revoked: boolean }
    expect(body.revoked).toBe(true)
    expect(mockDeleteUser).toHaveBeenCalledWith('existing_auth_id')
  })

  it('returns 404 if tenant has no portal access to revoke', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { auth_user_id: null },
            error: null,
          }),
        }),
      }),
    })

    const res = await app.request('/api/admin/tenants/tenant_1/revoke-access', {
      method: 'DELETE',
    }, env)
    expect(res.status).toBe(404)
  })
})
