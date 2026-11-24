// Deploy gate: fail CI when production Supabase Auth would let a stranger become an admin.
//
//   node scripts/check-auth-posture.mjs
//     Reads ${SUPABASE_URL}/auth/v1/settings with SUPABASE_ANON_KEY (the public settings endpoint;
//     the anon/publishable key already ships in the SPA, so no new secret is needed).
//
// Why (audit 2026-11-23 ora-pm MED admin-gate-depends-on-unverified-signup-setting):
// server/middleware/admin-auth.ts admits an ADMIN_EMAILS address whose email_confirmed_at is set.
// That proves mailbox ownership only while a self-sign-up must CONFIRM by email. With public
// sign-up open AND email autoconfirm on, anyone could sign up as an allowlisted admin address
// that has no auth user yet and receive a confirmed session on the money console. The setting
// lives in the Supabase dashboard, invisible to the code, so this gate checks it before deploy.
// Verified live 2026-11-24: sign-up open, mailer_autoconfirm false (safe), phone autoconfirm false.
//
// Exit codes: 0 safe · 1 unsafe posture (blocks the deploy) · 2 could not check (fail closed).

import { pathToFileURL } from 'node:url'

class PostureHttpError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`GET /auth/v1/settings -> ${Number(status)}`)
    this.name = 'PostureHttpError'
  }
}

// Identity sources allowed to be on. Everything else in `external` must be false: an OAuth / SSO
// provider creates or links users with email_confirmed_at taken from the PROVIDER's verified-email
// claim, so turning one on hands admin-address safety to that provider (review round 1).
// `email` is the admin OTP sign-in; `phone` users carry no email and are denied by admin-auth.
const ALLOWED_EXTERNAL = new Set(['email', 'phone'])

/**
 * @param {unknown} s the JSON body of GET /auth/v1/settings
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function evaluateAuthPosture(s) {
  const problems = []
  if (!s || typeof s !== 'object') return { ok: false, problems: ['settings response is not an object'] }
  const st = /** @type {Record<string, unknown>} */ (s)
  const bool = (v) => typeof v === 'boolean'
  for (const k of ['disable_signup', 'mailer_autoconfirm', 'saml_enabled']) {
    if (!bool(st[k])) problems.push(`settings field ${k} is missing or not a boolean (${JSON.stringify(st[k])})`)
  }
  const ext = st.external
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
    problems.push('settings field external is missing or not an object')
  } else {
    const e = /** @type {Record<string, unknown>} */ (ext)
    if (!bool(e.anonymous_users)) problems.push('settings field external.anonymous_users is missing or not a boolean')
    // Tripwire (review round 2): the provider map must actually be populated, or an enabled provider
    // the API stopped listing could not be seen.
    if (!bool(e.email)) problems.push('settings field external.email is missing or not a boolean (provider map not populated?)')
  }
  if (st.passkeys_enabled !== undefined && !bool(st.passkeys_enabled)) {
    problems.push(`settings field passkeys_enabled is not a boolean (${JSON.stringify(st.passkeys_enabled)})`)
  }
  if (problems.length) return { ok: false, problems }

  // Unconditional (review round 1): autoconfirm also applies to an email CHANGE, so even with public
  // sign-up disabled an existing non-tenant user could switch to an unused ADMIN_EMAILS address and
  // come out confirmed. Public sign-up being off does not make autoconfirm safe.
  if (st.mailer_autoconfirm === true) {
    problems.push('email autoconfirm is on: a sign-up or an email change to an ADMIN_EMAILS address would be confirmed without proving the mailbox')
  }
  const extObj = /** @type {Record<string, unknown>} */ (ext)
  if (extObj.anonymous_users === true) problems.push('anonymous sign-ins (external.anonymous_users) are enabled')
  const providers = Object.entries(extObj)
    .filter(([k, v]) => k !== 'anonymous_users' && !ALLOWED_EXTERNAL.has(k) && v !== false)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  if (providers.length) {
    problems.push(`external identity providers are enabled (${providers.join(', ')}): each would vouch for admin email addresses; review before enabling`)
  }
  if (st.saml_enabled === true) problems.push('SAML SSO is enabled: an SSO identity provider would vouch for admin email addresses')
  // Tripwire (review round 2): passkeys are off today; review the sign-up semantics before enabling.
  if (st.passkeys_enabled === true) problems.push('passkeys are enabled: review how a passkey sign-up interacts with ADMIN_EMAILS before enabling')
  return { ok: problems.length === 0, problems }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {(url: string, init?: RequestInit) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} fetchImpl
 * @param {{ log: (m: string) => void, error: (m: string) => void }} logger
 * @returns {Promise<0 | 1 | 2>}
 */
export async function runAuthPostureCheck(env, fetchImpl, logger) {
  const url = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const key = (env.SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !key) {
    logger.error('::error::auth posture: SUPABASE_URL and SUPABASE_ANON_KEY are required; cannot verify production auth settings (fail closed)')
    return 2
  }
  let body
  try {
    const res = await fetchImpl(`${url}/auth/v1/settings`, { headers: { apikey: key } })
    if (!res.ok) throw new PostureHttpError(res.status)
    body = await res.json()
  } catch (err) {
    // The CI log is public (tests/unit/workflow-log-egress.test.ts): only messages composed here are
    // printed -- never a response body or a raw error message. `-> <status>` and `fetch failed` are
    // the forms scripts/retry-transient.sh retries; a non-JSON reply is not retried.
    const why = err instanceof PostureHttpError ? err.message
      : err instanceof Error && err.name === 'SyntaxError' ? 'the response was not JSON'
        : `fetch failed (${err instanceof Error ? err.name : 'error'})`
    logger.error(`::error::auth posture: could not read /auth/v1/settings: ${why} (fail closed)`)
    return 2
  }
  const { ok, problems } = evaluateAuthPosture(body)
  if (!ok) {
    for (const p of problems) logger.error(`::error::auth posture: ${p}`)
    logger.error('Fix it in the Supabase dashboard: Authentication > Providers > Email: "Confirm email" ON; turn off every provider, SAML, passkeys or anonymous sign-ins named above (disabling public sign-up alone does NOT clear an autoconfirm failure). Then re-run the deploy.')
    return 1
  }
  logger.log('auth posture OK: a self-sign-up cannot obtain a confirmed session without proving the address')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not process.exit(): exiting while fetch's sockets close trips a libuv assertion on Windows.
  process.exitCode = await runAuthPostureCheck(process.env, (u, i) => fetch(u, i), { log: console.log, error: console.error })
}
