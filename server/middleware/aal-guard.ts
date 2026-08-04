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
// Decision logic deliberately mirrors src/portal/lib/mfa-guard.ts's
// checkAal2Guard exactly — keep the two in sync if either changes:
// nextLevel === 'aal2' && currentLevel !== 'aal2' means a verified factor
// exists but THIS session hasn't cleared the challenge yet. A tenant with
// no verified factor never sees nextLevel rise above currentLevel, so this
// is a no-op for them (matches the SPA's own behavior).
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

  if (data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') {
    return c.json({ error: 'Multi-factor authentication required for this action' }, 403)
  }

  await next()
}
