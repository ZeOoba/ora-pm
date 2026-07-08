import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { getDb } from '../db/client'
import { adminAuthMiddleware } from '../middleware/admin-auth'
import type { Env } from '../index'

export const portalAuthRouter = new Hono<{ Bindings: Env }>()

// Defense in depth: these endpoints create/delete Supabase auth users, so the
// router enforces admin auth itself (not only via the app-level gate in
// server/index.ts). Mirrors portalRouter's self-gating with tenantAuthMiddleware.
portalAuthRouter.use('/*', adminAuthMiddleware)

function adminClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// POST /api/admin/tenants/:id/invite
// Creates a Supabase auth user via invite email, stores auth_user_id on tenant
portalAuthRouter.post('/tenants/:id/invite', async (c) => {
  const tenantId = c.req.param('id')
  const db = getDb(c.env)

  const { data: tenant, error: fetchErr } = await db
    .from('tenants')
    .select('id, contact_email, auth_user_id')
    .eq('id', tenantId)
    .single()

  if (fetchErr || !tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (!tenant.contact_email) return c.json({ error: 'Tenant has no contact_email — add it first' }, 400)
  if (tenant.auth_user_id) return c.json({ error: 'Tenant already has portal access', auth_user_id: tenant.auth_user_id }, 409)

  const admin = adminClient(c.env)
  const { data, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    tenant.contact_email,
    { redirectTo: `${c.req.header('origin') ?? 'https://ora-pm.pages.dev'}/portal` }
  )

  if (inviteErr) return c.json({ error: inviteErr.message }, 500)
  if (!data?.user?.id) return c.json({ error: 'Invite returned no user' }, 500)

  const authUserId = data.user.id
  const { error: updateErr } = await db.from('tenants').update({ auth_user_id: authUserId }).eq('id', tenantId)
  if (updateErr) return c.json({ error: 'Failed to save auth_user_id' }, 500)

  return c.json({ invited: true, auth_user_id: authUserId })
})

// DELETE /api/admin/tenants/:id/revoke-access
portalAuthRouter.delete('/tenants/:id/revoke-access', async (c) => {
  const tenantId = c.req.param('id')
  const db = getDb(c.env)

  const { data: tenant, error: fetchErr } = await db
    .from('tenants')
    .select('auth_user_id')
    .eq('id', tenantId)
    .single()

  if (fetchErr) return c.json({ error: 'Failed to fetch tenant' }, 500)
  if (!tenant?.auth_user_id) return c.json({ error: 'No portal access to revoke' }, 404)

  const admin = adminClient(c.env)
  const { error: deleteErr } = await admin.auth.admin.deleteUser(tenant.auth_user_id)
  if (deleteErr) return c.json({ error: deleteErr.message }, 500)

  const { error: updateErr } = await db.from('tenants').update({ auth_user_id: null }).eq('id', tenantId)
  if (updateErr) return c.json({ error: 'Failed to clear auth_user_id' }, 500)

  return c.json({ revoked: true })
})
