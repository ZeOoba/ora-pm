// tests/scripts/check-auth-posture.test.ts
//
// Audit 2026-11-23 ora-pm MED (admin-gate-depends-on-unverified-signup-setting): adminAuthMiddleware
// admits an allowlisted email whose email_confirmed_at is set. That only proves mailbox ownership
// while production GoTrue makes a self-sign-up CONFIRM by email. If public sign-up is open AND
// email autoconfirm is on, anyone can sign up as an allowlisted admin address that has no auth user
// yet and get a confirmed session -- the money console. scripts/check-auth-posture.mjs reads the
// live /auth/v1/settings and fails the deploy on that posture.

import { describe, it, expect } from 'vitest'
import { evaluateAuthPosture, runAuthPostureCheck } from '../../scripts/check-auth-posture.mjs'

// Shape of the GET /auth/v1/settings response: providers and
// anonymous_users live under `external`; saml_enabled is top level.
const LIVE_EXTERNAL = {
  anonymous_users: false, apple: false, azure: false, bitbucket: false, discord: false, facebook: false,
  figma: false, fly: false, github: false, gitlab: false, google: false, keycloak: false, kakao: false,
  linkedin: false, linkedin_oidc: false, notion: false, slack: false, slack_oidc: false, spotify: false,
  twitch: false, twitter: false, workos: false, zoom: false, email: true, phone: false,
}
const settings = (o: Record<string, unknown> = {}, ext: Record<string, unknown> = {}) => ({
  disable_signup: false, mailer_autoconfirm: false, phone_autoconfirm: false, sms_provider: 'twilio',
  saml_enabled: false, passkeys_enabled: false, external: { ...LIVE_EXTERNAL, ...ext }, ...o,
})

describe('evaluateAuthPosture', () => {
  it('passes a safe posture (confirmations required, email the only provider)', () => {
    expect(evaluateAuthPosture(settings())).toEqual({ ok: true, problems: [] })
  })

  it('FAILS when email autoconfirm is on (admin-address takeover by sign-up)', () => {
    const r = evaluateAuthPosture(settings({ mailer_autoconfirm: true }))
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/autoconfirm/i)
  })

  it('FAILS on autoconfirm EVEN with public sign-up disabled (an email change would be auto-confirmed)', () => {
    expect(evaluateAuthPosture(settings({ disable_signup: true, mailer_autoconfirm: true })).ok).toBe(false)
  })

  it('FAILS when anonymous sign-ins are enabled (read from external.anonymous_users, the live shape)', () => {
    expect(evaluateAuthPosture(settings({}, { anonymous_users: true })).ok).toBe(false)
  })

  it('FAILS when any OAuth provider is enabled, or SAML', () => {
    for (const p of ['azure', 'google', 'github', 'keycloak', 'workos', 'some_new_provider']) {
      const r = evaluateAuthPosture(settings({}, { [p]: true }))
      expect(r.ok, p).toBe(false)
      expect(r.problems.join(' ')).toMatch(new RegExp(p))
    }
    expect(evaluateAuthPosture(settings({ saml_enabled: true })).ok).toBe(false)
  })

  it('allows phone (phone users carry no email; admin-auth denies them)', () => {
    expect(evaluateAuthPosture(settings({}, { phone: true })).ok).toBe(true)
  })

  it('fails closed on a malformed response (missing or non-boolean fields)', () => {
    expect(evaluateAuthPosture({}).ok).toBe(false)
    expect(evaluateAuthPosture(null).ok).toBe(false)
    expect(evaluateAuthPosture(settings({ mailer_autoconfirm: 'false' })).ok).toBe(false)
    expect(evaluateAuthPosture(settings({ disable_signup: undefined })).ok).toBe(false)
    expect(evaluateAuthPosture(settings({ saml_enabled: undefined })).ok).toBe(false)
    expect(evaluateAuthPosture(settings({ external: undefined })).ok).toBe(false)
    expect(evaluateAuthPosture(settings({}, { anonymous_users: undefined })).ok).toBe(false)
    expect(evaluateAuthPosture(settings({}, { azure: 'true' })).ok).toBe(false)
    // Review round 2 tripwires: an unpopulated provider map, and passkeys.
    expect(evaluateAuthPosture(settings({ external: { anonymous_users: false } })).ok).toBe(false)
    expect(evaluateAuthPosture(settings({ passkeys_enabled: true })).ok).toBe(false)
    expect(evaluateAuthPosture(settings({ passkeys_enabled: 'no' })).ok).toBe(false)
  })
})

describe('runAuthPostureCheck (exit-code contract)', () => {
  const logger = () => { const out: string[] = []; return { out, log: (m: string) => out.push(m), error: (m: string) => out.push(m) } }
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' }
  const respond = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body })

  it('0 on a safe posture, and it calls /auth/v1/settings with the apikey header', async () => {
    const calls: [string, RequestInit | undefined][] = []
    const fetchImpl = async (url: string, init?: RequestInit) => { calls.push([url, init]); return respond(settings({}))() }
    const l = logger()
    expect(await runAuthPostureCheck(env, fetchImpl, l)).toBe(0)
    expect(calls[0][0]).toBe('https://x.supabase.co/auth/v1/settings')
    expect((calls[0][1]?.headers as Record<string, string>).apikey).toBe('k')
  })

  it('1 on an unsafe posture', async () => {
    expect(await runAuthPostureCheck(env, respond(settings({ mailer_autoconfirm: true })), logger())).toBe(1)
  })

  it('2 (fail closed) when it cannot check: missing env, HTTP error, network error, bad JSON', async () => {
    expect(await runAuthPostureCheck({}, respond(settings({})), logger())).toBe(2)
    expect(await runAuthPostureCheck(env, respond({}, 500), logger())).toBe(2)
    expect(await runAuthPostureCheck(env, async () => { throw new Error('ECONNRESET') }, logger())).toBe(2)
    expect(await runAuthPostureCheck(env, async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }), logger())).toBe(2)
  })

  it('accepts a trailing slash on SUPABASE_URL', async () => {
    const urls: string[] = []
    await runAuthPostureCheck({ ...env, SUPABASE_URL: 'https://x.supabase.co/' }, async (u: string) => { urls.push(u); return respond(settings({}))() }, logger())
    expect(urls[0]).toBe('https://x.supabase.co/auth/v1/settings')
  })
})
