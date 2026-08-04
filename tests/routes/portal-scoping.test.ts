/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_ROUTES_DIR = join(__dirname, '../../server/routes')

// OI-048: server/db/client.ts's getDb() uses the Supabase SERVICE-ROLE key,
// which bypasses RLS entirely for every API request (see the comment block
// on client.ts and supabase/migrations/README.md). The RLS policies in
// 0004_views_and_rls.sql / 0008_storage_rls.sql are defense-in-depth for
// direct client access only — they do nothing to protect a request that goes
// through this Hono API. The REAL tenant-isolation control is that every
// portal/Stripe handler independently re-derives the caller's tenant row via
// `.eq('auth_user_id', <jwt-derived userId>)` before touching any other
// table, so a client can never read or write another tenant's data by
// supplying a different id in the request body/query string.
//
// This is a source-scan tripwire, not a runtime test: it greps the actual
// route handler source for that guard pattern, per-handler, so a future
// handler added without the guard fails CI instead of shipping an IDOR.

interface HandlerBlock {
  method: string
  path: string
  body: string
}

// Finds every `<routerVar>.<method>(<path>, async (c) => { ... })` handler
// in `source` and returns each one's body text. Uses brace-depth counting
// (not a fixed end-marker) to find the matching close, and discovers
// handlers by scanning for the router-call pattern generically — it does
// NOT take a hardcoded list of route names, so a newly added handler is
// picked up automatically (drift-immune, same principle as
// tests/db/ar-ledger.test.ts's "scan every migration, take the last
// definition" extraction).
function extractHandlers(source: string, routerVarName: string): HandlerBlock[] {
  const handlers: HandlerBlock[] = []
  const callRe = new RegExp(
    `${routerVarName}\\.(get|post|patch|put|delete)\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*,[^{]*?async\\s*\\(c\\)\\s*=>\\s*\\{`,
    'g'
  )
  let match: RegExpExecArray | null
  while ((match = callRe.exec(source)) !== null) {
    const method = match[1]
    const path = match[2]
    const bodyStart = match.index + match[0].length
    let depth = 1
    let i = bodyStart
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    if (depth !== 0) {
      throw new Error(`unbalanced braces scanning handler ${routerVarName}.${method}('${path}') — extraction boundary may be wrong`)
    }
    const bodyEnd = i - 1
    handlers.push({ method, path, body: source.slice(bodyStart, bodyEnd) })
  }
  return handlers
}

// The ownership guard: an `.eq('auth_user_id', ...)` filter, which is how
// every handler here re-derives "this row belongs to the authenticated
// caller" from the JWT-derived userId rather than trusting a client-supplied id.
const GUARD_RE = /\.eq\(\s*['"]auth_user_id['"]\s*,/

// Any `.from('<table>')` call — used to find data queries that happen
// relative to the guard.
function findFromCalls(body: string): { table: string; index: number }[] {
  const re = /\.from\(\s*['"]([\w.]+)['"]\s*\)/g
  const found: { table: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    found.push({ table: m[1], index: m.index })
  }
  return found
}

interface GuardCheckResult {
  ok: boolean
  reason?: string
}

// A handler is compliant if:
//   1. it contains the auth_user_id guard at all, and
//   2. every query against a table OTHER than 'tenants' occurs at or after
//      the guard's position in the source — i.e. the guard has already run
//      (and therefore the caller's own tenant id is known) before any other
//      table is touched. This catches both "no guard anywhere" (the common
//      IDOR shape) and "guard exists somewhere below the leak" (a handler
//      that queries first and checks ownership as an afterthought, which is
//      just as exploitable).
function checkHandlerGuard(body: string): GuardCheckResult {
  const guardMatch = GUARD_RE.exec(body)
  if (!guardMatch) {
    return { ok: false, reason: 'no .eq("auth_user_id", ...) guard found in handler body' }
  }
  const guardPos = guardMatch.index

  for (const { table, index } of findFromCalls(body)) {
    if (table === 'tenants') continue // this IS (part of) the guard's own query
    if (index < guardPos) {
      return {
        ok: false,
        reason: `queries "${table}" at position ${index}, before the auth_user_id guard at position ${guardPos}`,
      }
    }
  }
  return { ok: true }
}

function readRoute(filename: string): string {
  return readFileSync(join(SERVER_ROUTES_DIR, filename), 'utf8')
}

describe('portal-scoping scanner — self-test against fixtures (proves the scanner actually catches violations)', () => {
  // Two handlers in the SAME source string: one compliant, one not, plus a
  // third that has the guard present but placed AFTER the leaking query. If
  // extraction/checking were sloppy about per-handler boundaries (e.g. just
  // grepping "does the guard appear anywhere in the whole file"), the
  // compliant handler's guard would incorrectly cover its neighbors. Each
  // handler must be judged on its own body only.
  const fixtureSource = `
someRouter.get('/safe', async (c) => {
  const userId = c.get('tenantUserId')
  const db = getDb(c.env)
  const { data: tenant } = await db.from('tenants').select('id').eq('auth_user_id', userId).single()
  const { data } = await db.from('leases').select('*').eq('tenant_id', tenant.id)
  return c.json({ data })
})

someRouter.get('/vulnerable-no-guard', async (c) => {
  const { tenant_id } = await c.req.json()
  const db = getDb(c.env)
  const { data } = await db.from('leases').select('*').eq('tenant_id', tenant_id)
  return c.json({ data })
})

someRouter.get('/vulnerable-late-guard', async (c) => {
  const { tenant_id } = await c.req.json()
  const db = getDb(c.env)
  const userId = c.get('tenantUserId')
  const { data: leaked } = await db.from('leases').select('*').eq('tenant_id', tenant_id)
  const { data: tenant } = await db.from('tenants').select('id').eq('auth_user_id', userId).single()
  return c.json({ data: leaked })
})
`

  const fixtureHandlers = extractHandlers(fixtureSource, 'someRouter')

  it('extracts exactly the 3 fixture handlers, by path, in source order (proves extraction is not miscounting or merging bodies)', () => {
    expect(fixtureHandlers.map((h) => h.path)).toEqual(['/safe', '/vulnerable-no-guard', '/vulnerable-late-guard'])
  })

  it('passes the compliant handler', () => {
    const safe = fixtureHandlers.find((h) => h.path === '/safe')!
    expect(checkHandlerGuard(safe.body)).toEqual({ ok: true })
  })

  it('flags the handler with no guard at all — and is NOT fooled by the guard existing in a sibling handler in the same file', () => {
    const vulnerable = fixtureHandlers.find((h) => h.path === '/vulnerable-no-guard')!
    const result = checkHandlerGuard(vulnerable.body)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no .* guard found/)
  })

  it('flags the handler where the guard exists but runs AFTER the leaking query (guard-as-afterthought is still an IDOR)', () => {
    const vulnerable = fixtureHandlers.find((h) => h.path === '/vulnerable-late-guard')!
    const result = checkHandlerGuard(vulnerable.body)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/before the auth_user_id guard/)
  })
})

describe('portal-scoping scanner — real route source (OI-048)', () => {
  it('portal.ts has at least one handler (sanity check that extraction found real code, not an empty/renamed file)', () => {
    const source = readRoute('portal.ts')
    const handlers = extractHandlers(source, 'portalRouter')
    expect(handlers.length).toBeGreaterThan(0)
  })

  it('stripe.ts has at least one handler (sanity check that extraction found real code, not an empty/renamed file)', () => {
    const source = readRoute('stripe.ts')
    const handlers = extractHandlers(source, 'stripeRouter')
    expect(handlers.length).toBeGreaterThan(0)
  })

  it('every portal.ts handler resolves the tenant via the auth_user_id guard before any other table query', () => {
    const source = readRoute('portal.ts')
    const handlers = extractHandlers(source, 'portalRouter')
    for (const h of handlers) {
      const result = checkHandlerGuard(h.body)
      expect(result.ok, `portalRouter.${h.method}('${h.path}'): ${result.reason}`).toBe(true)
    }
  })

  it('every stripe.ts handler resolves the tenant via the auth_user_id guard before any other table query', () => {
    const source = readRoute('stripe.ts')
    const handlers = extractHandlers(source, 'stripeRouter')
    for (const h of handlers) {
      const result = checkHandlerGuard(h.body)
      expect(result.ok, `stripeRouter.${h.method}('${h.path}'): ${result.reason}`).toBe(true)
    }
  })
})
