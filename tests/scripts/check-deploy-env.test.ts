// tests/scripts/check-deploy-env.test.ts
//
// 2026-09-13: ADMIN_EMAILS was never provisioned on the Cloudflare Pages
// production project, so adminAuthMiddleware fail-closed every admin /api/*
// call with 503 for ~6 weeks (OI-036 shipped 2026-08-03) and nothing noticed.
// scripts/check-deploy-env.mjs gates the CI deploy on the Pages project and
// the build step actually carrying every variable the code needs. These tests
// cover the pure evaluation, the Cloudflare API parsing, the exit-code
// contract, and drift guards that force every env var the code reads to be
// classified in the manifest (so a new required var can't bypass the gate).

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  RUNTIME_ENV,
  DEFERRED_UNTIL,
  BUILD_ENV,
  RUNTIME_BINDINGS,
  evaluateEnv,
  presentPagesVars,
  runPagesCheck,
  runBuildCheck,
} from '../../scripts/check-deploy-env.mjs'

const ROOT = join(__dirname, '../..')

describe('evaluateEnv', () => {
  const manifest = { A: 'required', B: 'deferred', C: 'optional' } as const

  it('passes when every required var is present', () => {
    const r = evaluateEnv(manifest, new Set(['A', 'B']))
    expect(r.missingRequired).toEqual([])
    expect(r.missingDeferred).toEqual([])
  })

  it('reports a missing required var as blocking', () => {
    expect(evaluateEnv(manifest, new Set(['B'])).missingRequired).toEqual(['A'])
  })

  it('reports a missing deferred var as a warning only, and ignores optional vars', () => {
    const r = evaluateEnv(manifest, new Set(['A']))
    expect(r.missingRequired).toEqual([])
    expect(r.missingDeferred).toEqual(['B'])
  })
})

describe('presentPagesVars', () => {
  const project = (envVars: Record<string, unknown>) => ({
    success: true,
    result: { deployment_configs: { production: { env_vars: envVars } } },
  })

  it('counts secret_text vars as present (the API never returns their values)', () => {
    const names = presentPagesVars(project({ ADMIN_EMAILS: { type: 'secret_text' } }))
    expect(names.has('ADMIN_EMAILS')).toBe(true)
  })

  it('counts a plain_text var as present only when its value is non-empty', () => {
    const names = presentPagesVars(project({
      FULL: { type: 'plain_text', value: 'x' },
      EMPTY: { type: 'plain_text', value: '' },
      BLANK: { type: 'plain_text', value: '   ' },
    }))
    expect([...names].sort()).toEqual(['FULL'])
  })

  it('treats a null env_vars block as no vars', () => {
    expect(presentPagesVars(project(null as unknown as Record<string, unknown>)).size).toBe(0)
  })

  it('throws on an unsuccessful API response instead of reading it as "no vars"', () => {
    expect(() => presentPagesVars({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }))
      .toThrow(/Authentication error/)
  })

  it('throws when the production config is absent from a "successful" response', () => {
    expect(() => presentPagesVars({ success: true, result: {} })).toThrow(/production/)
  })
})

function allRuntimeVarsPresent(except: string[] = []) {
  const env_vars: Record<string, unknown> = {}
  for (const name of Object.keys(RUNTIME_ENV)) {
    if (!except.includes(name)) env_vars[name] = { type: 'secret_text' }
  }
  return { success: true, result: { deployment_configs: { production: { env_vars } } } }
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ status, json: async () => body })
}

const CREDS = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc' }

describe('runPagesCheck', () => {
  it('exits 0 when every required var is set, and queries the ora-pm project with the token', async () => {
    const fetchImpl = fakeFetch(allRuntimeVarsPresent())
    const out: string[] = []
    const code = await runPagesCheck({ env: CREDS, fetchImpl, log: (l: string) => out.push(l) })
    expect(code).toBe(0)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/pages/projects/ora-pm')
    expect(init.headers.Authorization).toBe('Bearer t')
  })

  it('exits 1 with a ::error:: naming ADMIN_EMAILS when it is missing (the 2026-09-13 outage)', async () => {
    const out: string[] = []
    const code = await runPagesCheck({ env: CREDS, fetchImpl: fakeFetch(allRuntimeVarsPresent(['ADMIN_EMAILS'])), log: (l: string) => out.push(l) })
    expect(code).toBe(1)
    expect(out.join('\n')).toMatch(/::error::.*ADMIN_EMAILS/)
  })

  it('exits 0 but emits a ::warning:: when only deferred (Stripe) vars are missing', async () => {
    const out: string[] = []
    const code = await runPagesCheck({
      env: CREDS,
      fetchImpl: fakeFetch(allRuntimeVarsPresent(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])),
      log: (l: string) => out.push(l),
    })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/::warning::.*STRIPE_SECRET_KEY/)
    expect(out.join('\n')).not.toMatch(/::error::/)
  })

  it('fails closed (exit 2) when the Cloudflare API call fails', async () => {
    const out: string[] = []
    const code = await runPagesCheck({
      env: CREDS,
      fetchImpl: fakeFetch({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403),
      log: (l: string) => out.push(l),
    })
    expect(code).toBe(2)
    expect(out.join('\n')).toMatch(/::error::.*Authentication error/)
  })

  it('fails closed (exit 2) when fetch itself rejects', async () => {
    const out: string[] = []
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    expect(await runPagesCheck({ env: CREDS, fetchImpl, log: (l: string) => out.push(l) })).toBe(2)
  })

  it('fails closed (exit 2) when credentials are absent', async () => {
    const out: string[] = []
    const fetchImpl = vi.fn()
    expect(await runPagesCheck({ env: {}, fetchImpl, log: (l: string) => out.push(l) })).toBe(2)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('--warn-only downgrades every failure to a ::warning:: and exit 0 (PR runs)', async () => {
    const out: string[] = []
    const missing = await runPagesCheck({ env: CREDS, warnOnly: true, fetchImpl: fakeFetch(allRuntimeVarsPresent(['ADMIN_EMAILS'])), log: (l: string) => out.push(l) })
    const noCreds = await runPagesCheck({ env: {}, warnOnly: true, fetchImpl: vi.fn(), log: (l: string) => out.push(l) })
    expect([missing, noCreds]).toEqual([0, 0])
    expect(out.join('\n')).not.toMatch(/::error::/)
    expect(out.join('\n')).toMatch(/::warning::.*ADMIN_EMAILS/)
  })
})

describe('runBuildCheck', () => {
  const allBuild = Object.fromEntries(Object.keys(BUILD_ENV).map((k) => [k, 'v']))

  it('exits 0 when every required build var is non-empty', () => {
    expect(runBuildCheck({ env: allBuild, log: () => {} })).toBe(0)
  })

  it('exits 1 when a required build var is empty (GitHub renders a missing secret as "")', () => {
    const out: string[] = []
    expect(runBuildCheck({ env: { ...allBuild, VITE_SUPABASE_URL: '' }, log: (l: string) => out.push(l) })).toBe(1)
    expect(out.join('\n')).toMatch(/::error::.*VITE_SUPABASE_URL/)
  })

  it('warns, not fails, on a missing deferred build var', () => {
    const out: string[] = []
    const { VITE_STRIPE_PUBLISHABLE_KEY: _drop, ...rest } = allBuild
    expect(runBuildCheck({ env: rest, log: (l: string) => out.push(l) })).toBe(0)
    expect(out.join('\n')).toMatch(/::warning::.*VITE_STRIPE_PUBLISHABLE_KEY/)
  })
})

describe('manifest classification', () => {
  it('pins the vars whose absence is known to break production', () => {
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET', 'ADMIN_EMAILS', 'CONFIDENTIAL_TERMS', 'ANTHROPIC_API_KEY']) {
      expect(RUNTIME_ENV[name], name).toBe('required')
    }
    expect(BUILD_ENV.VITE_SUPABASE_URL).toBe('required')
    expect(BUILD_ENV.VITE_SUPABASE_ANON_KEY).toBe('required')
  })

  it('names what each deferred variable waits for (not "tenant payments" for all of them)', () => {
    const deferred = [...Object.entries(RUNTIME_ENV), ...Object.entries(BUILD_ENV)].filter(([, c]) => c === 'deferred').map(([n]) => n)
    for (const name of deferred) expect(DEFERRED_UNTIL[name], name).toBeTruthy()
    expect(DEFERRED_UNTIL.GL_PERIOD_LOCK_EMAILS).toMatch(/month-end close/)
    expect(DEFERRED_UNTIL.STRIPE_SECRET_KEY).toBe('tenant payments launch')
  })

  it('keeps Stripe deferred until tenant payments launch', () => {
    expect(RUNTIME_ENV.STRIPE_SECRET_KEY).toBe('deferred')
    expect(RUNTIME_ENV.STRIPE_WEBHOOK_SECRET).toBe('deferred')
    expect(BUILD_ENV.VITE_STRIPE_PUBLISHABLE_KEY).toBe('deferred')
  })
})

function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p, exts)
    return exts.some((e) => p.endsWith(e)) ? [p] : []
  })
}

describe('drift guard — every env var the code reads is classified', () => {
  const serverFiles = () => [
    ...walk(join(ROOT, 'server'), ['.ts', '.tsx', '.js', '.mjs']),
    ...walk(join(ROOT, 'functions'), ['.ts', '.tsx', '.js', '.mjs']),
  ]

  // Every server-side env-name source this repo uses: `...Env` interface/type
  // members (server/index.ts plus route-local ones like cron.ts and
  // admin-auth.ts), dotted reads (`c.env.X`, `env?.X`, and cast reads such as
  // auth.ts's `(c.env as { CRON_SECRET?: string })?.CRON_SECRET`), bracket
  // reads (`c.env['X']`), and destructuring (`const { X } = c.env`).
  function serverEnvNames() {
    const names = new Set<string>()
    for (const f of serverFiles()) {
      const src = readFileSync(f, 'utf-8')
      for (const block of src.matchAll(/(?:interface\s+\w*Env\w*|type\s+\w*Env\w*\s*=)\s*\{([\s\S]*?)\n\}/g)) {
        for (const m of block[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\??:/gm)) names.add(m[1])
      }
      for (const m of src.matchAll(/\benv\b[^;\n]{0,80}?\??\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1])
      for (const m of src.matchAll(/\benv\??\.?\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g)) names.add(m[1])
      for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*\w*\.?env\b/g)) {
        for (const k of m[1].matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) names.add(k[1])
      }
    }
    return names
  }

  it('finds env names through every access pattern the server uses today', () => {
    const names = serverEnvNames()
    expect(names.has('ADMIN_EMAILS')).toBe(true) // c.env.ADMIN_EMAILS + admin-auth.ts local AdminEnv
    expect(names.has('CRON_SECRET')).toBe(true) // auth.ts cast read + cron.ts local Env
    expect(names.has('RATE_LIMIT_KV')).toBe(true)
  })

  it('every env name the server declares or reads is in RUNTIME_ENV or RUNTIME_BINDINGS', () => {
    for (const n of serverEnvNames()) {
      expect(n in RUNTIME_ENV || RUNTIME_BINDINGS.includes(n), `server uses env ${n} but it is unclassified`).toBe(true)
    }
  })

  it('every import.meta.env.VITE_* read under src/ is in BUILD_ENV', () => {
    const names = new Set<string>()
    for (const f of walk(join(ROOT, 'src'), ['.ts', '.tsx'])) {
      for (const m of readFileSync(f, 'utf-8').matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) names.add(m[1])
    }
    expect(names.size).toBeGreaterThan(0)
    for (const n of names) expect(n in BUILD_ENV, `src reads ${n} but it is not in BUILD_ENV`).toBe(true)
  })
})

describe('ci.yml wiring', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')
  const stepIndex = (name: string) => ci.indexOf(`- name: ${name}`)

  it('passes every BUILD_ENV var to the Build step', () => {
    const build = ci.slice(stepIndex('Build'), ci.indexOf('- name:', stepIndex('Build') + 1))
    for (const k of Object.keys(BUILD_ENV)) expect(build, `Build step missing ${k}`).toContain(`${k}: \${{ secrets.${k} }}`)
  })

  it('runs the Pages check after the tip check and before Deploy, under the same condition as Deploy', () => {
    const check = stepIndex('Check Cloudflare Pages production env')
    const tip = stepIndex('Check commit is still the tip of main')
    const deploy = stepIndex('Deploy to Cloudflare Pages')
    expect(check).toBeGreaterThan(-1)
    expect(tip).toBeLessThan(check)
    expect(check).toBeLessThan(deploy)
    const step = ci.slice(check, deploy)
    expect(step).toContain("steps.tip.outputs.deploy == 'true'")
    expect(step).toContain('node scripts/check-deploy-env.mjs pages')
    expect(step).not.toContain('--warn-only')
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
  })

  it('runs a warn-only Pages check on pull requests so misconfiguration surfaces before merge', () => {
    const idx = stepIndex('Preview Cloudflare Pages production env (PR, warn-only)')
    expect(idx).toBeGreaterThan(-1)
    const step = ci.slice(idx, ci.indexOf('- name:', idx + 1))
    expect(step).toContain("github.event_name == 'pull_request'")
    expect(step).toContain('node scripts/check-deploy-env.mjs pages --warn-only')
  })

  it('checks build env before Build on main pushes (strict) and PRs (warn-only)', () => {
    const idx = stepIndex('Check build-time env')
    expect(idx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(stepIndex('Build'))
    const step = ci.slice(idx, stepIndex('Build'))
    expect(step).toContain('node scripts/check-deploy-env.mjs build')
    for (const k of Object.keys(BUILD_ENV)) expect(step).toContain(`${k}: \${{ secrets.${k} }}`)
  })
})
