import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(__dirname, '../../scripts/stage-statement-drafts.ps1')
const source = readFileSync(SCRIPT, 'utf8')

// Hard Invariant 1 guard: the stager may only ever create drafts.
describe('stage-statement-drafts.ps1 — static', () => {
  it('has no send call', () => {
    const code = source.replace(/<#[\s\S]*?#>/g, '').split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toMatch(/\.Send\s*\(/i)
    expect(code).not.toMatch(/send-via-outlook|send-parked-drafts/i)
    expect(code).toMatch(/\.Save\(\)/)
  })
})

// Dry-run behaviour needs a PowerShell; skipped where none is installed.
const shell = ['pwsh', 'powershell'].find(s => spawnSync(s, ['-NoProfile', '-Command', 'exit 0']).status === 0)
const run = (packet: string, dry = true) => spawnSync(shell!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Packet', packet, ...(dry ? ['-DryRun'] : [])], { encoding: 'utf8' })

describe.skipIf(!shell)('stage-statement-drafts.ps1 — dry run', () => {
  let dir = ''
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'stmt-packet-')) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  const write = (name: string, body: unknown) => { const p = join(dir, name); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); return p }
  const item = (over: Record<string, unknown> = {}) => ({ lease_id: 'lease-1', to: 'pat@acme.example', subject: 'Statement of Account — Test Park, Suite B2', html: '<p>Hi</p>', ...over })

  it('validates a good packet and prints lease ids only (no PII)', () => {
    const r = run(write('ok.json', { version: 1, items: [item(), item({ lease_id: 'lease-2', to: 'x@y.example' })], skipped: [] }))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('VALID 2 items')
    expect(r.stdout).toContain('WOULD-STAGE lease=lease-2')
    expect(r.stdout).not.toContain('pat@acme.example')
    expect(r.stdout).not.toContain('Test Park')
  })

  it.each([
    ['two @', item({ to: 'a@b@c.example' })],
    ['list separator', item({ to: 'a@b.example;c@d.example' })],
    ['no domain dot', item({ to: 'a@b' })],
    ['multi-line subject', item({ subject: 'x\r\nBcc: a@b.example' })],
    ['empty body', item({ html: '  ' })],
    ['no lease id', item({ lease_id: '' })],
  ])('refuses the whole packet on %s (exit 3, nothing staged)', (_label, bad) => {
    const r = run(write(`bad-${Math.random()}.json`, { version: 1, items: [item(), bad] }))
    expect(r.status).toBe(3)
    expect(r.stdout).not.toContain('WOULD-STAGE')
  })

  it('refuses a missing file, bad JSON and a wrong version', () => {
    expect(run(join(dir, 'nope.json')).status).toBe(3)
    expect(run(write('junk.json', '{not json')).status).toBe(3)
    expect(run(write('v2.json', { version: 2, items: [] })).status).toBe(3)
  })
})
