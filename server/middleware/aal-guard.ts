import { createClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'

type Env = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }

// OI-045 (server-side gap): the browser SPA's post-login AAL2 gate
// (src/portal/PortalApp.tsx + src/portal/lib/mfa-guard.ts) only decides
// which React component renders — it provides zero protection against a
// direct API call with a valid bearer JWT. A tenant who has enrolled a
// verified TOTP factor but whose CURRENT session hasn't completed the
// challenge (aal1) could call PATCH /api/portal/autopay directly, skipping
// the SPA and the MFA step-up entirely, and attach a bank account for ACH
// autopay. This middleware enforces the same decision server-side, so it
// holds even against a request that never touches the browser UI.
//
// OI-081: the original condition, `nextLevel === 'aal2' && currentLevel !==
// 'aal2'`, is a no-op for a tenant who has NEVER enrolled MFA at all —
// `nextLevel` only reaches 'aal2' once a verified factor exists, so an
// unenrolled tenant's request sails through with only a valid magic-link
// session (aal1) as its sole control. That is the realistic majority case
// (enrollment is voluntary — src/portal/pages/PortalAccount.tsx:90), so this
// guard protected far less than its presence implied.
//
// Fix: this middleware now REQUIRES currentLevel === 'aal2' outright on
// every route it gates — money-movement actions (autopay, ACH setup,
// payment) mandate a completed MFA challenge, full stop, rather than only
// enforcing it for tenants who happened to already enroll. This
// deliberately DIVERGES from src/portal/lib/mfa-guard.ts's checkAal2Guard,
// which still gates only which React screen renders post-login for GENERAL
// portal navigation (viewing a lease, rent history, etc. — actions that
// were never in scope for MFA in the first place). Do not "resync" the two
// by loosening this one back to the SPA's condition — that reintroduces the
// exact gap OI-081 closes. An unenrolled tenant hitting one of these three
// routes now gets a distinct message steering them to enroll, rather than
// the SPA's "complete your challenge" copy, which does not apply to them.
export async function requireAal2(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!jwt) return c.json({ error: 'Missing Authorization header' }, 401)

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Passing the JWT explicitly (rather than relying on an in-memory
  // session, which a stateless per-request Worker never has) is the
  // documented server-side/Edge-Function form of this call — it makes a
  // real network request to validate the token and fetch the user's MFA
  // factors, unlike the zero-arg current-session form the SPA uses.
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel(jwt)

  // Fail CLOSED: any error checking AAL blocks the sensitive action rather
  // than silently letting it through. Never echo the raw error — same
  // hygiene as dbError() (OI-042).
  if (error || !data) {
    console.error('[ORA PM] AAL check failed:', error?.message)
    return c.json({ error: 'Unable to verify authentication level' }, 403)
  }

  if (data.currentLevel !== 'aal2') {
    if (data.nextLevel === 'aal2') {
      // A verified factor exists; this session just hasn't cleared the
      // challenge yet — same case the original condition caught.
      return c.json({ error: 'Multi-factor authentication required for this action' }, 403)
    }
    // OI-081: no verified factor enrolled at all — block instead of the
    // prior no-op, and say so distinctly so the client can route the
    // tenant to enrollment rather than a (nonexistent) challenge step.
    return c.json(
      { error: 'Multi-factor authentication is required for this action. Enroll an authenticator before continuing.' },
      403,
    )
  }

  await next()
}
