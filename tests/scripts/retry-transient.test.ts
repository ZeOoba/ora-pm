import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(__dirname, '../../scripts/retry-transient.sh')

// A fake command: prints the Nth line of `outputs` on its Nth call and exits with the Nth code.
function fake(outputs: string[], codes: number[]) {
  const dir = mkdtempSync(join(tmpdir(), 'retry-'))
  const counter = join(dir, 'n')
  writeFileSync(counter, '0')
  const cmd = join(dir, 'cmd.sh')
  writeFileSync(cmd, `#!/usr/bin/env bash
n=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"
outs=(${outputs.map((o) => `'${o}'`).join(' ')}); codes=(${codes.join(' ')})
echo "\${outs[$((n-1))]}"; exit "\${codes[$((n-1))]}"
`, { mode: 0o755 })
  const run = () => spawnSync('bash', [SCRIPT, cmd], { env: { ...process.env, RETRY_DELAY: '0' }, encoding: 'utf8' })
  return { run, calls: () => Number(readFileSync(counter, 'utf8')) }
}

describe('scripts/retry-transient.sh', () => {
  it('passes a success straight through', () => {
    const f = fake(['ok'], [0])
    const r = f.run()
    expect(r.status).toBe(0)
    expect(f.calls()).toBe(1)
    expect(r.stdout).toContain('ok')
  })

  it("retries a Cloudflare 503 (wrangler's message) and succeeds", () => {
    const f = fake(['POST /accounts/x/pages/projects/ora-pm/deployments -> 503 Service Unavailable', 'Deployment complete'], [1, 0])
    const r = f.run()
    expect(r.status).toBe(0)
    expect(f.calls()).toBe(2)
    expect(r.stdout).toContain('retrying')
  })

  it('retries the env check when the API reply is not JSON', () => {
    const f = fake(['::error::Could not verify Pages env: Cloudflare API request failed (SyntaxError)', 'OK'], [2, 0])
    expect(f.run().status).toBe(0)
    expect(f.calls()).toBe(2)
  })

  it('does not retry a real failure (a missing variable), and keeps its exit code', () => {
    const f = fake(['::error::CRIT_ALERT_RECIPIENTS is not set'], [1])
    const r = f.run()
    expect(r.status).toBe(1)
    expect(f.calls()).toBe(1)
  })

  it('gives up after 3 transient failures with the last exit code', () => {
    const f = fake(['upstream connect error', 'upstream connect error', 'upstream connect error'], [1, 1, 7])
    const r = f.run()
    expect(r.status).toBe(7)
    expect(f.calls()).toBe(3)
    expect(r.stdout).toContain('still failing after 3 attempts')
  })
})

describe('ci.yml: Cloudflare retries and the deploy-failure alert', () => {
  const ci = readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
  const step = (name: string) => { const i = ci.indexOf(`- name: ${name}`); return ci.slice(i, ci.indexOf('- name:', i + 1) === -1 ? undefined : ci.indexOf('- name:', i + 1)) }
  it('wraps the Pages env check and the deploy in the retry script', () => {
    expect(step('Check Cloudflare Pages production env')).toContain('scripts/retry-transient.sh node scripts/check-deploy-env.mjs pages')
    expect(step('Deploy to Cloudflare Pages')).toContain('scripts/retry-transient.sh npx wrangler pages deploy')
  })
  it('alerts through one GitHub issue when a main run fails, with only issues: write added', () => {
    const alert = step('Alert on a failed production deploy')
    expect(alert).toContain("if: failure() && github.ref == 'refs/heads/main' && github.event_name == 'push'")
    expect(alert).toContain('gh issue comment')
    expect(alert).toContain('gh issue create')
    expect(ci).toMatch(/permissions:\n\s+contents: read\n\s+issues: write\n/)
  })
})
