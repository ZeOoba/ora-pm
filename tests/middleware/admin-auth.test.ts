import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { adminAuthMiddleware } from '../../server/middleware/admin-auth'

const mockGetUser = vi.hoisted(() => vi.fn())
const mockMaybeSingle = vi.hoisted(() => vi.fn())
const mockFrom = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  ADMIN_EMAILS: 'ggoldberg@oxfordra.net, egoldberg@oxfordra.net',
}

function makeApp() {
  const app = new Hono<{ Bindings: typeof env }>()
  app.use('/*', adminAuthMiddleware)
  app.get('/ping', (c) => c.json({ ok: true }))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no tenant row matches the authenticated user (not a tenant).
  mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: mockMaybeSingle,
      }),
    }),
  })
})

describe('adminAuthMiddleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = makeApp()
    const res = await app.request('/ping', {}, env)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/missing/i)
  })

  it('returns 401 when Authorization header has empty token', async () => {
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer ' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns 401 when JWT is invalid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid jwt' } })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer bad-token' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns 401 when getUser returns null user with no error', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer revoked-token' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns 403 when authenticated user email is not in ADMIN_EMAILS (RED 1)', async () => {
    // random@oxfordra.net is a valid domain but not on the allowlist — the old
    // suffix check would have passed this; the allowlist must reject it.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'random@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, env)
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/forbidden/i)
  })

  it('returns 403 when the email is allowlisted but a tenants row shares the auth_user_id (RED 2)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'tenant_1' }, error: null })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, env)
    expect(res.status).toBe(403)
    expect(mockFrom).toHaveBeenCalledWith('tenants')
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/forbidden/i)
  })

  it('returns 503 when ADMIN_EMAILS is unset (RED 3)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const unsetEnv = { ...env, ADMIN_EMAILS: undefined }
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, unsetEnv)
    expect(res.status).toBe(503)
  })

  it('returns 503 when ADMIN_EMAILS is an empty string (RED 3)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const emptyEnv = { ...env, ADMIN_EMAILS: '' }
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, emptyEnv)
    expect(res.status).toBe(503)
  })

  it('allows through an allowlisted admin who is not a tenant (RED 4)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer valid-token' },
    }, env)
    expect(res.status).toBe(200)
  })

  it('allowlist match is case-insensitive', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'GGoldberg@OxfordRA.net' } },
      error: null,
    })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer valid-token' },
    }, env)
    expect(res.status).toBe(200)
  })

  it('fails closed (rejects, does not reach next()) when the tenant-exclusion query errors', async () => {
    // A network blip, RLS misconfiguration, or transient outage on the tenants
    // lookup must never silently degrade to "not a tenant, let them through" —
    // the request must be rejected, not passed to next().
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ggoldberg@oxfordra.net' } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'connection timeout', code: '08006' },
    })
    const app = makeApp()
    const res = await app.request('/ping', {
      headers: { Authorization: 'Bearer some-token' },
    }, env)
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// P1 T12 — admin_users role DATA MODEL. The lookup runs only after every check above has passed,
// records adminRole / adminEntityScope on the context, and never changes the access decision:
// roles are not enforced in P1 and ADMIN_EMAILS stays the sole authority for admin access.
//   row found -> its role/scope · no row -> 'owner'/null · lookup error -> null/null (UNKNOWN)
// ---------------------------------------------------------------------------
describe('adminAuthMiddleware — admin_users role lookup (T12, recorded not enforced)', () => {
  type DbResult = { data: unknown; error: unknown }
  const SCOPE_A = '00000000-0000-0000-0000-00000000000a'
  const SCOPE_B = '00000000-0000-0000-0000-00000000000b'

  const tenantMaybeSingle = vi.fn()
  const adminSelect = vi.fn()
  const adminEq = vi.fn()
  const adminMaybeSingle = vi.fn()

  // Per-table chains, so the tenants exclusion lookup and the admin_users role lookup are armed
  // independently and the role query's exact shape can be asserted. An Error rejects the lookup.
  function armTables(opts: { tenant?: DbResult; adminUser?: DbResult | Error } = {}) {
    tenantMaybeSingle.mockResolvedValue(opts.tenant ?? { data: null, error: null })
    const adminUser = opts.adminUser ?? { data: null, error: null }
    if (adminUser instanceof Error) adminMaybeSingle.mockRejectedValue(adminUser)
    else adminMaybeSingle.mockResolvedValue(adminUser)
    adminEq.mockReturnValue({ maybeSingle: adminMaybeSingle })
    adminSelect.mockReturnValue({ eq: adminEq })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_users') return { select: adminSelect }
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: tenantMaybeSingle }) }) }
    })
  }

  function asUser(email: string) {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email } }, error: null })
  }

  // What the downstream handler saw; stays null when the middleware rejected the request.
  let seen: { role: unknown; scope: unknown; userId: unknown; email: unknown } | null
  function makeRoleApp() {
    const app = new Hono<{ Bindings: typeof env }>()
    app.use('/*', adminAuthMiddleware)
    app.get('/ping', (c) => {
      seen = {
        role: c.get('adminRole'),
        scope: c.get('adminEntityScope'),
        userId: c.get('adminUserId'),
        email: c.get('adminEmail'),
      }
      return c.json({ ok: true })
    })
    return app
  }
  const request = (e: Partial<typeof env> = env) =>
    makeRoleApp().request('/ping', { headers: { Authorization: 'Bearer valid-token' } }, e)

  const tablesQueried = () => mockFrom.mock.calls.map(([table]) => table)

  const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
  let warnSpy: ReturnType<typeof spyWarn>
  beforeEach(() => {
    seen = null
    warnSpy = spyWarn()
    asUser('ggoldberg@oxfordra.net')
    armTables()
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  // --- row found / no row ---------------------------------------------------

  it("allowlisted admin with NO admin_users row -> adminRole 'owner', adminEntityScope null (legacy behaviour)", async () => {
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen).not.toBeNull()
    expect(seen!.role).toBe('owner')
    expect(seen!.scope).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("allowlisted admin with a 'viewer' row -> adminRole 'viewer' and its entity_scope", async () => {
    armTables({ adminUser: { data: { role: 'viewer', entity_scope: [SCOPE_A, SCOPE_B] }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBe('viewer')
    expect(seen!.scope).toEqual([SCOPE_A, SCOPE_B])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it.each(['owner', 'manager', 'bookkeeper', 'viewer'])("records a stored '%s' role verbatim", async (role) => {
    armTables({ adminUser: { data: { role, entity_scope: null }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBe(role)
    expect(seen!.scope).toBeNull()
  })

  it('a row whose entity_scope key is absent records a null scope (row.entity_scope ?? null)', async () => {
    armTables({ adminUser: { data: { role: 'manager' }, error: null } })
    await request()
    expect(seen!.role).toBe('manager')
    expect(seen!.scope).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('records an empty entity_scope as [] (not coerced to null — the two may mean different things later)', async () => {
    armTables({ adminUser: { data: { role: 'bookkeeper', entity_scope: [] }, error: null } })
    await request()
    expect(seen!.role).toBe('bookkeeper')
    expect(seen!.scope).toEqual([])
  })

  it('still sets adminUserId and adminEmail exactly as before', async () => {
    armTables({ adminUser: { data: { role: 'manager', entity_scope: null }, error: null } })
    await request()
    expect(seen!.userId).toBe('u1')
    expect(seen!.email).toBe('ggoldberg@oxfordra.net')
  })

  // --- the allowlist stays authoritative: rejected requests never read admin_users -----------

  it('non-allowlisted email WITH an admin_users row -> still 403, and admin_users is never queried', async () => {
    asUser('random@oxfordra.net')
    armTables({ adminUser: { data: { role: 'owner', entity_scope: null }, error: null } })
    const res = await request()
    expect(res.status).toBe(403)
    expect(seen).toBeNull()
    expect(tablesQueried()).not.toContain('admin_users')
  })

  it('allowlisted email that is also a tenant (tenant row) WITH an owner row -> still 403, admin_users never queried', async () => {
    armTables({
      tenant: { data: { id: 'tenant_1' }, error: null },
      adminUser: { data: { role: 'owner', entity_scope: null }, error: null },
    })
    const res = await request()
    expect(res.status).toBe(403)
    expect(seen).toBeNull()
    expect(tablesQueried()).toEqual(['tenants'])
  })

  it('ADMIN_EMAILS empty WITH an owner row -> still 503; neither getUser nor admin_users is touched', async () => {
    armTables({ adminUser: { data: { role: 'owner', entity_scope: null }, error: null } })
    const res = await request({ ...env, ADMIN_EMAILS: '' })
    expect(res.status).toBe(503)
    expect(seen).toBeNull()
    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('invalid JWT WITH an owner row -> still 401, admin_users never queried', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid jwt' } })
    armTables({ adminUser: { data: { role: 'owner', entity_scope: null }, error: null } })
    const res = await request()
    expect(res.status).toBe(401)
    expect(seen).toBeNull()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('tenant-lookup error -> still 500 (fail closed), admin_users never queried', async () => {
    armTables({
      tenant: { data: null, error: { message: 'connection timeout', code: '08006' } },
      adminUser: { data: { role: 'owner', entity_scope: null }, error: null },
    })
    const res = await request()
    expect(res.status).toBe(500)
    expect(seen).toBeNull()
    expect(tablesQueried()).toEqual(['tenants'])
  })

  // --- query shape ------------------------------------------------------------

  it('looks the row up by the LOWER-CASED auth email, selecting only role and entity_scope, in one query after the tenant check', async () => {
    asUser('GGoldberg@OxfordRA.net')
    armTables({ adminUser: { data: { role: 'viewer', entity_scope: null }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(tablesQueried()).toEqual(['tenants', 'admin_users'])
    expect(adminSelect).toHaveBeenCalledTimes(1)
    expect(adminSelect).toHaveBeenCalledWith('role, entity_scope')
    expect(adminEq).toHaveBeenCalledTimes(1)
    expect(adminEq).toHaveBeenCalledWith('email', 'ggoldberg@oxfordra.net')
    expect(adminMaybeSingle).toHaveBeenCalledTimes(1)
    expect(seen!.role).toBe('viewer')
  })

  // --- lookup error -> UNKNOWN (null), request continues, access unchanged ----------------------

  it.each([
    ['0018 not applied yet: relation does not exist (42P01)', { code: '42P01', message: 'relation "public.admin_users" does not exist' }],
    ['0018 not applied yet: table missing from the PostgREST schema cache (PGRST205)', { code: 'PGRST205', message: "Could not find the table 'public.admin_users' in the schema cache" }],
    ['more than one row (PGRST116)', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }],
    ['transient connection failure (08006)', { code: '08006', message: 'connection failure' }],
  ])('lookup error, %s -> request proceeds, adminRole null (UNKNOWN), one warning', async (_label, error) => {
    armTables({ adminUser: { data: null, error } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen).not.toBeNull()
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warnSpy.mock.calls)
    expect(logged).toContain(error.code)
    // No PII or credentials in the log line: neither the email nor the bearer token.
    expect(logged).not.toMatch(/ggoldberg|valid-token/i)
  })

  it('lookup that REJECTS (thrown network error) -> request proceeds, adminRole null, one warning', async () => {
    armTables({ adminUser: new Error('TypeError: fetch failed') })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('lookup that throws synchronously while building the query -> request proceeds, adminRole null', async () => {
    adminSelect.mockImplementation(() => {
      throw new TypeError('unexpected client shape')
    })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['admin', 'admin'],
    ['wrong case', 'Owner'],
    ['blank', ''],
    ['null', null],
    ['missing', undefined],
    ['non-string', 42],
  ])('unrecognized stored role (%s) -> treated as a lookup error: adminRole null, request proceeds', async (_label, role) => {
    armTables({ adminUser: { data: { role, entity_scope: null }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a string', 'not-an-array'],
    ['non-string elements', [1, 2]],
    ['a null element', [SCOPE_A, null]],
    ['an object', { 0: SCOPE_A }],
  ])('malformed entity_scope (%s) -> the WHOLE row is rejected: adminRole null, never a valid role with no scope', async (_label, entity_scope) => {
    armTables({ adminUser: { data: { role: 'viewer', entity_scope }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
