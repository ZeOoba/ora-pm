import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { adminAuthMiddleware } from './middleware/admin-auth'
import { propertiesRouter } from './routes/properties'
import { unitsRouter } from './routes/units'
import { tenantsRouter } from './routes/tenants'
import { leasesRouter } from './routes/leases'
import { chargesRouter } from './routes/charges'
import { paymentsRouter } from './routes/payments'
import { cronRouter } from './routes/cron'
import { reportsRouter } from './routes/reports'
import { camRouter } from './routes/cam'
import { expensesRouter } from './routes/expenses'
import { budgetsRouter } from './routes/budgets'
import { renewalsRouter } from './routes/renewals'
import { insuranceRouter } from './routes/insurance'
import { exportsRouter } from './routes/exports'
import { stripeRouter } from './routes/stripe'
import { webhookRouter } from './routes/webhook'
import { portalAuthRouter } from './routes/portal-auth'
import { portalRouter } from './routes/portal'
import { portalInsuranceRouter } from './routes/portal-insurance'
import { intakeRouter } from './routes/intake'
import { searchRouter } from './routes/search'
import { statementsRouter } from './routes/statements'
import { glRouter } from './routes/gl'
import { errorHandlerMiddleware } from './middleware/error-handler'
import { checkRateLimit } from './lib/rate-limit'

// OI-037: explicit CORS allowlist — the app was previously mounting Hono's bare
// cors(), whose default `origin: '*'` echoes Access-Control-Allow-Origin: * to
// any caller on every /api/* route (admin CRUD, portal, and Stripe endpoints
// included). Origins:
//   - https://ora-pm.pages.dev  — confirmed live production host (curl -I).
//   - https://pm.oxfordra.net, https://tenant.oxfordra.net — documented custom
//     domains (README.md "DNS" step: CNAME to ora-pm.pages.dev); DNS is not yet
//     live (unresolvable as of this change) and cutover needs Gabriel's explicit
//     go-ahead per README, but listing them here is inert until then and avoids a
//     second code change the day DNS goes live.
//   - http://localhost:5173 — Vite dev server.
const ALLOWED = [
  'https://ora-pm.pages.dev',
  'https://pm.oxfordra.net',
  'https://tenant.oxfordra.net',
  'http://localhost:5173',
]

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  ANTHROPIC_API_KEY?: string
  CONFIDENTIAL_TERMS?: string  // comma-separated denylist; never commit real terms
  INTAKE_MODEL?: string        // optional override for the lease-intake extraction model
  ADMIN_EMAILS?: string        // comma-separated exact-match admin allowlist (OI-036); see admin-auth.ts
  GL_PERIOD_LOCK_EMAILS?: string // comma-separated: who may lock a GL period (B8). Unset = nobody (fail-closed)
  // OI-038 remainder: durable, cross-isolate rate-limit counter storage. See
  // server/lib/rate-limit.ts for the KV-backed limiter and wrangler.toml for
  // the binding (and the manual provisioning step still needed before this
  // is live in production — checkRateLimit degrades gracefully to
  // memory-only when unbound, so its absence is safe, not silent-broken).
  RATE_LIMIT_KV?: KVNamespace
}

// Roots that skip adminAuthMiddleware: public, or authenticated by their own router (webhook
// signature, CRON_SECRET, tenant JWT). NOTE: /api/admin is intentionally NOT exempt — its tenant
// invite/revoke endpoints are privileged admin actions and must pass adminAuthMiddleware.
export const ADMIN_EXEMPT: readonly string[] = [
  '/api/webhooks',
  '/api/cron',
  '/api/portal',
  '/api/health',
  '/api/stripe',
]

/**
 * True when `path` is an exempt root or lies beneath one. M13 (2026-11-08 audit): matched on a
 * path-segment boundary — a bare startsWith exempted any look-alike ("/api/portalX",
 * "/api/stripe-x"). Callers pass c.req.path, the same path Hono's router matches on, so the gate
 * and the router can never disagree about which route a request reaches.
 */
export function isAdminExempt(path: string): boolean {
  return ADMIN_EXEMPT.some((root) => path === root || path.startsWith(`${root}/`))
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>()

  app.use('*', errorHandlerMiddleware)

  // Webhook MUST be before CORS — needs raw body
  app.route('/api/webhooks', webhookRouter)

  app.use('/api/*', cors({
    origin: (origin) => (ALLOWED.includes(origin) ? origin : undefined),
    credentials: false,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }))

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', ts: new Date().toISOString() })
  )

  // Admin auth: gate all /api/* routes except public/already-authed paths (ADMIN_EXEMPT, below).
  app.use('/api/*', async (c, next) => {
    if (isAdminExempt(c.req.path)) return next()
    return adminAuthMiddleware(c as unknown as Parameters<typeof adminAuthMiddleware>[0], next)
  })

  // OI-038 remainder: generic abuse-protection cap on every admin-gated
  // MUTATION route (properties/units/tenants/leases/charges/... CRUD +
  // intake — see rate-limit.ts's file header for the KV-durability and
  // eventually-consistent trade-off). Generous (120/min) — this guards
  // against abuse/compromised-credential hammering, not normal admin UX; a
  // legitimate admin session never comes close. Read-only (GET) admin
  // traffic is intentionally NOT limited here. /api/intake/lease additionally
  // carries its own tighter, LLM-spend-specific limit (see intake.ts) — the
  // two buckets are independent and both apply on that route.
  const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
  app.use('/api/*', async (c, next) => {
    if (isAdminExempt(c.req.path)) return next()
    if (!MUTATION_METHODS.has(c.req.method)) return next()
    const adminUserId = c.get('adminUserId') ?? 'unknown-admin'
    const { allowed, retryAfterMs } = await checkRateLimit(c.env.RATE_LIMIT_KV, adminUserId, {
      scope: 'admin-mutation',
      maxCalls: 120,
      windowMs: 60_000,
    })
    if (!allowed) {
      return c.json({ error: `Too many requests — retry in ${Math.ceil(retryAfterMs / 1000)}s` }, 429)
    }
    return next()
  })

  app.route('/api/properties', propertiesRouter)
  app.route('/api/units', unitsRouter)
  app.route('/api/tenants', tenantsRouter)
  app.route('/api/leases', leasesRouter)
  app.route('/api/charges', chargesRouter)
  app.route('/api/payments', paymentsRouter)
  app.route('/api/cron', cronRouter)
  app.route('/api/reports', reportsRouter)
  app.route('/api/cam', camRouter)
  app.route('/api/expenses', expensesRouter)
  app.route('/api/budgets', budgetsRouter)
  app.route('/api/renewals', renewalsRouter)
  app.route('/api/insurance', insuranceRouter)
  app.route('/api/exports', exportsRouter)
  app.route('/api/intake', intakeRouter)
  app.route('/api/search', searchRouter)
  app.route('/api/statements', statementsRouter)
  app.route('/api/gl', glRouter)
  app.route('/api/stripe', stripeRouter)
  app.route('/api/admin', portalAuthRouter)
  app.route('/api/portal', portalRouter)
  app.route('/api/portal/insurance', portalInsuranceRouter)

  return app
}

export default createApp()
