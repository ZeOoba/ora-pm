/// <reference types="node" />
import { inspect } from 'node:util'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { adminAuthMiddleware, ROLE_LOOKUP_TIMEOUT_MS } from '../../server/middleware/admin-auth'

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
        // The T12 admin_users role lookup chains .abortSignal() before .maybeSingle().
        abortSignal: vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle }),
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
// records adminRole / adminEntityScope / adminRoleSource on the context, and never changes the
// access decision: roles are not enforced in P1 and ADMIN_EMAILS stays the sole authority for
// admin access. The request always proceeds to next():
//   valid row (recognized role, well-formed scope) -> row.role, row.entity_scope ?? null, 'row'
//   no row                                         -> null, null, 'none'   (no warning)
//   query error, rejection, throw, timeout, unrecognized role, malformed scope, malformed result
//                                                  -> null, null, 'error'  (one warning, no PII)
// ---------------------------------------------------------------------------
describe('adminAuthMiddleware — admin_users role lookup (T12, recorded not enforced)', () => {
  type DbResult = { data: unknown; error: unknown }
  const SCOPE_A = '00000000-0000-0000-0000-00000000000a'
  const SCOPE_B = '00000000-0000-0000-0000-00000000000b'
  const ADMIN = 'ggoldberg@oxfordra.net'
  const USER_ID = 'auth-user-7f3a91c4'
  const TOKEN = 'bearer-token-5c2e08'

  const tenantMaybeSingle = vi.fn()
  const adminSelect = vi.fn()
  const adminEq = vi.fn()
  const adminAbortSignal = vi.fn()
  const adminMaybeSingle = vi.fn()

  // Per-table chains, so the tenants exclusion lookup and the admin_users role lookup are armed
  // independently and the role query's exact shape can be asserted. The admin_users chain mirrors
  // postgrest-js, where .abortSignal() exists before .maybeSingle() and not after it. An Error
  // rejects the lookup.
  function armTables(opts: { tenant?: DbResult; adminUser?: DbResult | Error } = {}) {
    tenantMaybeSingle.mockResolvedValue(opts.tenant ?? { data: null, error: null })
    const adminUser = opts.adminUser ?? { data: null, error: null }
    if (adminUser instanceof Error) adminMaybeSingle.mockRejectedValue(adminUser)
    else adminMaybeSingle.mockResolvedValue(adminUser)
    adminAbortSignal.mockReturnValue({ maybeSingle: adminMaybeSingle })
    adminEq.mockReturnValue({ abortSignal: adminAbortSignal })
    adminSelect.mockReturnValue({ eq: adminEq })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'admin_users') return { select: adminSelect }
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: tenantMaybeSingle }) }) }
    })
  }

  // Arms the admin_users query to answer only after `ms` of (fake) time, or never; with `onAbort`
  // it also answers the way postgrest-js does once its AbortSignal fires. Returns a promise that
  // resolves when the query is issued, so a test moves the clock only after the middleware has
  // started its timer.
  function delayLookup(ms: number | 'never', answer: DbResult = { data: null, error: null }, onAbort?: DbResult) {
    let markIssued!: () => void
    const issued = new Promise<void>((resolve) => {
      markIssued = resolve
    })
    adminMaybeSingle.mockImplementation(() => {
      markIssued()
      const signal = adminAbortSignal.mock.calls.at(-1)?.[0] as AbortSignal | undefined
      return new Promise((resolve) => {
        if (ms !== 'never') setTimeout(() => resolve(answer), ms)
        if (onAbort) signal?.addEventListener('abort', () => resolve(onAbort))
      })
    })
    return issued
  }

  function asUser(email: string) {
    mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID, email } }, error: null })
  }

  // What the downstream handler saw; stays null when the middleware rejected the request.
  let seen: { role: unknown; scope: unknown; source: unknown; userId: unknown; email: unknown } | null
  function makeRoleApp() {
    const app = new Hono<{ Bindings: typeof env }>()
    app.use('/*', adminAuthMiddleware)
    app.get('/ping', (c) => {
      seen = {
        role: c.get('adminRole'),
        scope: c.get('adminEntityScope'),
        source: c.get('adminRoleSource'),
        userId: c.get('adminUserId'),
        email: c.get('adminEmail'),
      }
      return c.json({ ok: true })
    })
    return app
  }
  const request = (e: Partial<typeof env> = env) =>
    makeRoleApp().request('/ping', { headers: { Authorization: `Bearer ${TOKEN}` } }, e)

  const tablesQueried = () => mockFrom.mock.calls.map(([table]) => table)

  // Every console channel is captured, so a leak through any of them is caught, not only warn.
  const spyConsole = () => ({
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
  })
  let consoleSpy: ReturnType<typeof spyConsole>
  let warnSpy: ReturnType<typeof spyConsole>['warn']

  // No PII or credentials in ANY log line on ANY path. Asserted after EVERY test in this block (row,
  // no row, query error, rejection, synchronous throw, unprintable throw, timeout, unrecognized
  // role, malformed scope, malformed result), not only where a test remembers to check.
  const FORBIDDEN_IN_LOGS: Array<[string, RegExp]> = [
    ['admin email (local part or domain, any case)', /ggoldberg|oxfordra/i],
    ['auth user id', new RegExp(USER_ID)],
    ['bearer token', new RegExp(TOKEN)],
    ['service-role key', new RegExp(env.SUPABASE_SERVICE_ROLE_KEY)],
  ]
  const render = (arg: unknown): string => {
    if (typeof arg === 'string') return arg
    try {
      return inspect(arg, { depth: 8, showHidden: true })
    } catch {
      return '[uninspectable]'
    }
  }

  beforeEach(() => {
    seen = null
    consoleSpy = spyConsole()
    warnSpy = consoleSpy.warn
    asUser(ADMIN)
    armTables()
  })
  afterEach(() => {
    try {
      const logged = Object.values(consoleSpy)
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map(render).join(' '))
        .join('\n')
      for (const [what, pattern] of FORBIDDEN_IN_LOGS) {
        expect(logged, `a log line leaks the ${what}`).not.toMatch(pattern)
      }
    } finally {
      for (const spy of Object.values(consoleSpy)) spy.mockRestore()
      vi.useRealTimers()
    }
  })

  // --- row found / no row ---------------------------------------------------

  it("allowlisted admin with NO admin_users row -> adminRole null, adminRoleSource 'none', scope null, no warning", async () => {
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen).not.toBeNull()
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('none')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("allowlisted admin with a 'viewer' row -> adminRole 'viewer', its entity_scope, source 'row'", async () => {
    armTables({ adminUser: { data: { role: 'viewer', entity_scope: [SCOPE_A, SCOPE_B] }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBe('viewer')
    expect(seen!.scope).toEqual([SCOPE_A, SCOPE_B])
    expect(seen!.source).toBe('row')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it.each(['owner', 'manager', 'bookkeeper', 'viewer'])("records a stored '%s' role verbatim, source 'row'", async (role) => {
    armTables({ adminUser: { data: { role, entity_scope: null }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBe(role)
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('row')
  })

  it("a row whose entity_scope key is absent records a null scope (row.entity_scope ?? null), source 'row'", async () => {
    armTables({ adminUser: { data: { role: 'manager' }, error: null } })
    await request()
    expect(seen!.role).toBe('manager')
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('row')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('records an empty entity_scope as [] (not coerced to null — the two may mean different things later)', async () => {
    armTables({ adminUser: { data: { role: 'bookkeeper', entity_scope: [] }, error: null } })
    await request()
    expect(seen!.role).toBe('bookkeeper')
    expect(seen!.scope).toEqual([])
    expect(seen!.source).toBe('row')
  })

  it('still sets adminUserId and adminEmail exactly as before', async () => {
    armTables({ adminUser: { data: { role: 'manager', entity_scope: null }, error: null } })
    await request()
    expect(seen!.userId).toBe(USER_ID)
    expect(seen!.email).toBe(ADMIN)
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

  it('looks the row up by the LOWER-CASED auth email, selecting only role and entity_scope, with an abort signal, in one query after the tenant check', async () => {
    asUser('GGoldberg@OxfordRA.net')
    armTables({ adminUser: { data: { role: 'viewer', entity_scope: null }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(tablesQueried()).toEqual(['tenants', 'admin_users'])
    expect(adminSelect).toHaveBeenCalledTimes(1)
    expect(adminSelect).toHaveBeenCalledWith('role, entity_scope')
    expect(adminEq).toHaveBeenCalledTimes(1)
    expect(adminEq).toHaveBeenCalledWith('email', 'ggoldberg@oxfordra.net')
    expect(adminAbortSignal).toHaveBeenCalledTimes(1)
    expect(adminAbortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal)
    expect(adminMaybeSingle).toHaveBeenCalledTimes(1)
    expect(seen!.role).toBe('viewer')
    expect(seen!.source).toBe('row')
  })

  // --- time bound: a stalled lookup can never hold the request -----------------------------

  it('exports the role-lookup bound: 1500 ms', () => {
    expect(ROLE_LOOKUP_TIMEOUT_MS).toBe(1500)
  })

  it("a lookup that never answers -> after 1500 ms the request proceeds: 200, adminRole null, source 'error', query aborted", async () => {
    vi.useFakeTimers()
    const issued = delayLookup('never')
    let settled = false
    const pending = Promise.resolve(request()).then((res) => {
      settled = true
      return res
    })
    await issued
    const signal = adminAbortSignal.mock.calls[0][0] as AbortSignal
    await vi.advanceTimersByTimeAsync(1499)
    expect(settled).toBe(false)
    expect(seen).toBeNull()
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const res = await pending
    expect(res.status).toBe(200)
    expect(seen).not.toBeNull()
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(signal.aborted).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/timed out/i)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("the aborted query answering late (as postgrest-js does, with an AbortError result) changes nothing: one warning, source 'error'", async () => {
    vi.useFakeTimers()
    const issued = delayLookup('never', undefined, {
      data: null,
      error: { code: '', message: 'AbortError: This operation was aborted' },
    })
    const pending = request()
    await issued
    await vi.advanceTimersByTimeAsync(ROLE_LOOKUP_TIMEOUT_MS)
    const res = await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/timed out/i)
  })

  it('a lookup answering within the bound (500 ms) still records the role, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const issued = delayLookup(500, { data: { role: 'viewer', entity_scope: [SCOPE_A] }, error: null })
    const pending = request()
    await issued
    await vi.advanceTimersByTimeAsync(500)
    const res = await pending
    expect(res.status).toBe(200)
    expect(seen!.role).toBe('viewer')
    expect(seen!.scope).toEqual([SCOPE_A])
    expect(seen!.source).toBe('row')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['a valid row', { data: { role: 'manager', entity_scope: null }, error: null }],
    ['no row', { data: null, error: null }],
    ['a query error', { data: null, error: { code: '08006', message: 'connection failure' } }],
    ['a rejected query', new Error('TypeError: fetch failed')],
  ] as Array<[string, DbResult | Error]>)(
    'the bound timer is cleared as soon as the lookup settles (%s): no timer left behind',
    async (_label, adminUser) => {
      vi.useFakeTimers()
      armTables({ adminUser })
      const res = await request()
      expect(res.status).toBe(200)
      expect(seen).not.toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('the bound timer is cleared when building the query throws synchronously', async () => {
    vi.useFakeTimers()
    adminSelect.mockImplementation(() => {
      throw new TypeError('unexpected client shape')
    })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.source).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
  })

  // --- lookup failure -> null, source 'error', request continues, access unchanged ----------

  it.each([
    ['0018 not applied yet: relation does not exist (42P01)', { code: '42P01', message: 'relation "public.admin_users" does not exist' }],
    ['0018 not applied yet: table missing from the PostgREST schema cache (PGRST205)', { code: 'PGRST205', message: "Could not find the table 'public.admin_users' in the schema cache" }],
    ['more than one row (PGRST116)', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }],
    ['transient connection failure (08006)', { code: '08006', message: 'connection failure' }],
  ])("lookup error, %s -> request proceeds, adminRole null, source 'error', one warning naming the code", async (_label, error) => {
    armTables({ adminUser: { data: null, error } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen).not.toBeNull()
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warnSpy.mock.calls)).toContain(error.code)
  })

  it("lookup that REJECTS (thrown network error) -> request proceeds, adminRole null, source 'error', one warning", async () => {
    armTables({ adminUser: new Error('TypeError: fetch failed') })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it("lookup that throws synchronously while building the query -> request proceeds, adminRole null, source 'error'", async () => {
    adminSelect.mockImplementation(() => {
      throw new TypeError('unexpected client shape')
    })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  // String(value) throws for each of these. If describing the failure threw inside the catch, the
  // lookup would reject and the middleware would answer 500, i.e. a role lookup would deny access.
  const unprintable: Array<[string, () => unknown]> = [
    ['a null-prototype object', () => Object.create(null)],
    [
      'an object whose toString throws',
      () => ({
        toString() {
          throw new Error('hostile toString')
        },
      }),
    ],
    [
      'an Error whose message getter throws',
      () =>
        Object.defineProperty(new Error(), 'message', {
          get() {
            throw new Error('hostile message')
          },
        }),
    ],
  ]

  it.each(unprintable)("lookup that THROWS %s -> request proceeds: 200, adminRole null, source 'error', one warning", async (_label, make) => {
    adminSelect.mockImplementation(() => {
      throw make()
    })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen).not.toBeNull()
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each(unprintable)("lookup that REJECTS with %s -> request proceeds: 200, adminRole null, source 'error', one warning", async (_label, make) => {
    adminMaybeSingle.mockImplementation(() => Promise.reject(make()))
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen).not.toBeNull()
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an object with no data or error key', {}],
    ['a null-prototype object', Object.create(null)],
    ['data: undefined', { data: undefined, error: null }],
    ['data: a string', { data: 'viewer', error: null }],
  ])("a malformed query result (%s) is a lookup error, never 'no row': source 'error', one warning", async (_label, result) => {
    adminMaybeSingle.mockResolvedValue(result)
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['admin', 'admin'],
    ['wrong case', 'Owner'],
    ['blank', ''],
    ['null', null],
    ['missing', undefined],
    ['non-string', 42],
  ])("unrecognized stored role (%s) -> source 'error': adminRole null, and the row's scope is NOT recorded", async (_label, role) => {
    armTables({ adminUser: { data: { role, entity_scope: [SCOPE_A] }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a string', 'not-an-array'],
    ['non-string elements', [1, 2]],
    ['a null element', [SCOPE_A, null]],
    ['an object', { 0: SCOPE_A }],
  ])("malformed entity_scope (%s) -> the WHOLE row is rejected: adminRole null, source 'error', never a valid role with no scope", async (_label, entity_scope) => {
    armTables({ adminUser: { data: { role: 'viewer', entity_scope }, error: null } })
    const res = await request()
    expect(res.status).toBe(200)
    expect(seen!.role).toBeNull()
    expect(seen!.scope).toBeNull()
    expect(seen!.source).toBe('error')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
