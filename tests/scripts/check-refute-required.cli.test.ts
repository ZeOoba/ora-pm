/// <reference types="node" />
// M12 (2026-11-08 audit): the REFUTE gate's main() — real git, real process exit code — had no
// test, and under --strict it exited 0 when the base ref could not be resolved. These tests spawn
// the script against a throwaway git repository so the git plumbing, the base resolution and the
// exit code are exercised exactly as CI runs them (`npm run check:refute -- --strict`).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const TSX_CLI = require.resolve('tsx/cli')
const SCRIPT = path.resolve(__dirname, '../../scripts/check-refute-required.ts')

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  })
}

function write(rel: string, body: string): void {
  const full = path.join(repo, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, body)
}

function runGate(...args: string[]): { code: number | null; out: string } {
  const env = { ...process.env }
  delete env.REFUTE_BASE
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env })
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'refute-gate-'))
  git('init', '-q', '-b', 'base')
  write('README.md', 'base\n')
  write('server/lib/postgrest-paging.ts', 'export const X = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
})

afterAll(() => {
  // Throwaway fixture under the OS temp dir, created by this test.
  if (repo) rmSync(repo, { recursive: true, force: true })
})

describe('check-refute-required CLI (spawned against a fixture repo)', () => {
  it('--strict exits 1 when --base names a ref that does not exist (fail CLOSED)', () => {
    git('checkout', '-q', '-B', 'unknown-base', 'base')
    const r = runGate('--strict', '--base=origin/does-not-exist')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/does-not-exist/)
  }, 30_000)

  it('--strict exits 1 on an EMPTY --base (it used to diff HEAD...HEAD and pass)', () => {
    git('checkout', '-q', '-B', 'empty-base', 'base')
    write('server/lib/postgrest-paging.ts', 'export const X = 9\n')
    git('commit', '-q', '-am', 'change paging')
    const r = runGate('--strict', '--base=')
    expect(r.code).toBe(1)
  }, 30_000)

  it('without --strict the same unresolvable base only warns (exit 0)', () => {
    git('checkout', '-q', '-B', 'unknown-base', 'base')
    const r = runGate('--base=origin/does-not-exist')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/skipped/)
  }, 30_000)

  it('--strict exits 1 on a financial change with no trailer, naming the file', () => {
    git('checkout', '-q', '-B', 'no-trailer', 'base')
    write('server/lib/postgrest-paging.ts', 'export const X = 2\n')
    git('commit', '-q', '-am', 'change paging')
    const r = runGate('--strict', '--base=base')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/server\/lib\/postgrest-paging\.ts/)
  }, 30_000)

  it('--strict exits 0 once a commit in the range carries Refute-Reviewed', () => {
    git('checkout', '-q', '-B', 'with-trailer', 'base')
    write('server/lib/postgrest-paging.ts', 'export const X = 3\n')
    git('commit', '-q', '-am', 'change paging')
    git('commit', '-q', '--allow-empty', '-m', 'attest\n\nRefute-Reviewed: fixture-review')
    const r = runGate('--strict', '--base=base')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/trailer is present/)
  }, 30_000)

  it('--strict exits 0 when only non-financial files changed', () => {
    git('checkout', '-q', '-B', 'docs-only', 'base')
    write('README.md', 'docs\n')
    git('commit', '-q', '-am', 'docs')
    const r = runGate('--strict', '--base=base')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no financial-decision files/)
  }, 30_000)
})
