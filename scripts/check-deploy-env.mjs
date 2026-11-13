// Deploy gate: fail CI when an env var the app needs is missing.
//
//   node scripts/check-deploy-env.mjs pages [--warn-only]
//     Reads the Cloudflare Pages ora-pm PRODUCTION env config via the API
//     (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — the same credentials the
//     deploy step uses) and checks it against RUNTIME_ENV.
//   node scripts/check-deploy-env.mjs build [--warn-only]
//     Checks the build step's process.env against BUILD_ENV (Vite inlines
//     VITE_* at build time, so these come from GitHub Actions secrets, not Pages).
//
// Why: ADMIN_EMAILS was never provisioned on Pages production, so
// adminAuthMiddleware fail-closed every admin /api/* call with 503 from
// OI-036's deploy (2026-08-03) until 2026-09-13, and nothing flagged it.
//
// Classification:
//   required — absence breaks a live feature -> exit 1, blocks the deploy
//   deferred — needed only by a not-yet-launched feature -> ::warning::, exit 0
//   optional — has a safe code default -> not checked
// Promote a deferred var to required when its feature launches. Every env var
// the code reads must appear here; tests/scripts/check-deploy-env.test.ts
// fails on an unclassified one.
//
// Limitation: the Cloudflare API never returns secret_text values, so a secret
// that exists but holds "" (or "," for a list like ADMIN_EMAILS) still counts
// as present. This catches unset vars, not bad values; a post-deploy request to
// an admin route is the only way to prove the value works.
//
// Exit codes: 0 ok · 1 required var missing · 2 could not check (fail closed).
// --warn-only (pull-request runs) reports every problem as ::warning:: and
// exits 0, so PRs surface misconfiguration without being blocked by it.

import { pathToFileURL } from 'node:url'

export const PAGES_PROJECT = 'ora-pm'

/** @typedef {Record<string, 'required' | 'deferred' | 'optional'>} EnvManifest */

/** @type {EnvManifest} */
export const RUNTIME_ENV = {
  SUPABASE_URL: 'required',
  SUPABASE_SERVICE_ROLE_KEY: 'required',
  CRON_SECRET: 'required', // cron auth fails closed without it
  ADMIN_EMAILS: 'required', // admin-auth.ts 503s every admin route without it (OI-036)
  CONFIDENTIAL_TERMS: 'required', // intake.ts 503s lease intake without it
  ANTHROPIC_API_KEY: 'required', // intake.ts 501s lease extraction without it
  STRIPE_SECRET_KEY: 'deferred', // tenant payments / autopay — pre-launch
  STRIPE_WEBHOOK_SECRET: 'deferred', // tenant payments — pre-launch
  INTAKE_MODEL: 'optional', // intake.ts resolveModel() falls back to DEFAULT_MODEL
  CRIT_ALERT_RECIPIENTS: 'required', // cron.ts critical-date alerts 503 without it (kept out of the public repo)
  GL_PERIOD_LOCK_EMAILS: 'deferred', // B8 ledger: period lock fails closed (403) until set; needed at first month-end close
}

// Bindings are configured in wrangler.toml, not as env vars, so the Pages
// env-var API can't see them. RATE_LIMIT_KV degrades to memory-only when unbound.
export const RUNTIME_BINDINGS = ['RATE_LIMIT_KV']

/** @type {EnvManifest} */
export const BUILD_ENV = {
  VITE_SUPABASE_URL: 'required',
  VITE_SUPABASE_ANON_KEY: 'required',
  VITE_STRIPE_PUBLISHABLE_KEY: 'deferred', // portal Pay Now — pre-launch
}

/**
 * @param {EnvManifest} manifest
 * @param {Set<string>} present
 */
export function evaluateEnv(manifest, present) {
  const missing = (level) =>
    Object.entries(manifest)
      .filter(([name, l]) => l === level && !present.has(name))
      .map(([name]) => name)
  return { missingRequired: missing('required'), missingDeferred: missing('deferred') }
}

/**
 * Names of production env vars that actually carry a value. secret_text values
 * are never returned by the API, so their presence is all we can check.
 * @param {any} body Cloudflare "get Pages project" response
 */
/** An error whose message this script composed from the API's structured `errors` array. */
export class CloudflareApiError extends Error {}

export function presentPagesVars(body) {
  if (!body || body.success !== true) {
    const msg = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || 'unsuccessful response'
    throw new CloudflareApiError(`Cloudflare API error: ${msg}`)
  }
  const production = body.result?.deployment_configs?.production
  if (!production) throw new CloudflareApiError('Cloudflare API response has no production deployment config')
  const names = new Set()
  for (const [name, v] of Object.entries(production.env_vars ?? {})) {
    if (v?.type === 'secret_text') names.add(name)
    else if (typeof v?.value === 'string' && v.value.trim() !== '') names.add(name)
  }
  return names
}

function report(result, where, { warnOnly, log }) {
  const errLevel = warnOnly ? 'warning' : 'error'
  for (const name of result.missingRequired) {
    log(`::${errLevel}::${name} is required but not set on ${where}`)
  }
  for (const name of result.missingDeferred) {
    log(`::warning::${name} is not set on ${where} (deferred: needed only once tenant payments launch)`)
  }
  if (result.missingRequired.length === 0) log(`OK: every required variable is set on ${where}`)
  return result.missingRequired.length > 0 && !warnOnly ? 1 : 0
}

/**
 * @param {{ env: Record<string, string|undefined>, fetchImpl?: typeof fetch, warnOnly?: boolean, log?: (line: string) => void }} opts
 */
export async function runPagesCheck({ env, fetchImpl = fetch, warnOnly = false, log = console.log }) {
  const fail = (msg) => {
    log(`::${warnOnly ? 'warning' : 'error'}::Could not verify Pages env: ${msg}`)
    return warnOnly ? 0 : 2
  }
  const token = env.CLOUDFLARE_API_TOKEN
  const account = env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !account) return fail('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set')

  let present
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${PAGES_PROJECT}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    present = presentPagesVars(await res.json())
  } catch (err) {
    // Only messages composed above are printed. A fetch or JSON-parse error can quote the response
    // body (the CI log is public), so for those only the error's name is.
    return fail(err instanceof CloudflareApiError ? err.message : `Cloudflare API request failed (${err instanceof Error ? err.name : 'error'})`)
  }
  return report(evaluateEnv(RUNTIME_ENV, present), `Cloudflare Pages "${PAGES_PROJECT}" production`, { warnOnly, log })
}

/**
 * GitHub Actions renders an unset secret as an empty string, so empty counts as missing.
 * @param {{ env: Record<string, string|undefined>, warnOnly?: boolean, log?: (line: string) => void }} opts
 */
export function runBuildCheck({ env, warnOnly = false, log = console.log }) {
  const present = new Set(Object.keys(BUILD_ENV).filter((k) => (env[k] ?? '').trim() !== ''))
  return report(evaluateEnv(BUILD_ENV, present), 'the build environment', { warnOnly, log })
}

// Direct-run guard compared via pathToFileURL (a string-built file:// URL never
// matches import.meta.url on Windows). No shebang: vitest imports this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...flags] = process.argv.slice(2)
  const warnOnly = flags.includes('--warn-only')
  if (mode === 'pages') {
    process.exitCode = await runPagesCheck({ env: process.env, warnOnly })
  } else if (mode === 'build') {
    process.exitCode = runBuildCheck({ env: process.env, warnOnly })
  } else {
    console.error('usage: node scripts/check-deploy-env.mjs <pages|build> [--warn-only]')
    process.exitCode = 2
  }
}
