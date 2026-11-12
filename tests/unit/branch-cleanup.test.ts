import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { planCleanup, STALE_DAYS } from '../../scripts/branch-cleanup.mjs'

const REPO = 'acme/app'
const NOW = new Date('2026-11-11T12:00:00Z')
const br = (name: string, sha: string, prot = false) => ({ name, commit: { sha }, protected: prot })
const pr = (number: number, ref: string, sha: string, o: { state?: string; merged_at?: string | null; closed_at?: string | null; repo?: string } = {}) =>
  ({ number, state: o.state ?? 'closed', merged_at: o.merged_at ?? null, closed_at: o.closed_at ?? null, head: { ref, sha, repo: { full_name: o.repo ?? REPO } } })
const run = (branches: unknown[], pulls: unknown[], explicit: string[] = []) => {
  const p = planCleanup({ branches, pulls, defaultBranch: 'main', repo: REPO, now: NOW, explicit })
  return { del: p.delete.map((d: { name: string }) => d.name).sort(), keep: Object.fromEntries(p.keep.map((k: { name: string; reason: string }) => [k.name, k.reason])) }
}

describe('branch cleanup plan', () => {
  it('deletes a merged branch whose tip is the merged head; keeps one with commits after the merge', () => {
    const r = run([br('main', 'm'), br('feat/a', 'a1'), br('fix/b', 'b2')],
      [pr(1, 'feat/a', 'a1', { merged_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-01T00:00:00Z' }), pr(2, 'fix/b', 'b1', { merged_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-01T00:00:00Z' })])
    expect(r.del).toEqual(['feat/a'])
    expect(r.keep['fix/b']).toBe('commits after its last PR')
    expect(r.keep.main).toBe('default branch')
  })

  it(`deletes a branch closed unmerged more than ${STALE_DAYS} days ago, not a recent one`, () => {
    const r = run([br('old', 'o'), br('recent', 'r')],
      [pr(3, 'old', 'o', { closed_at: '2026-10-01T00:00:00Z' }), pr(4, 'recent', 'r', { closed_at: '2026-11-05T00:00:00Z' })])
    expect(r.del).toEqual(['old'])
    expect(r.keep.recent).toMatch(/closed less than 14 days ago/)
  })

  it('never deletes: open PR, no PR, protected, or a fork PR with the same branch name', () => {
    const r = run([br('wip', 'w'), br('open', 'o2'), br('prot', 'p', true), br('forked', 'f')],
      [pr(5, 'open', 'o1', { merged_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-01T00:00:00Z' }), pr(6, 'open', 'o2', { state: 'open' }),
        pr(7, 'prot', 'p', { merged_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-01T00:00:00Z' }),
        pr(8, 'forked', 'f', { merged_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-01T00:00:00Z', repo: 'someone/fork' })])
    expect(r.del).toEqual([])
    expect(r.keep).toMatchObject({ wip: 'no PR (possible work in progress)', open: 'open PR #6', prot: 'protected', forked: 'no PR (possible work in progress)' })
  })

  it('explicit names delete on a manual run, but never main, protected, or open-PR branches', () => {
    const r = run([br('main', 'm'), br('fix/cam-followups', 'x'), br('open', 'o'), br('prot', 'p', true)],
      [pr(9, 'fix/cam-followups', 'y', { merged_at: '2026-10-01T00:00:00Z', closed_at: '2026-10-01T00:00:00Z' }), pr(10, 'open', 'o', { state: 'open' })],
      ['main', 'fix/cam-followups', 'open', 'prot'])
    expect(r.del).toEqual(['fix/cam-followups'])
  })

  it('the workflow runs the script, defaults manual runs to dry run, and needs only contents:write', () => {
    const wf = readFileSync('.github/workflows/branch-cleanup.yml', 'utf8')
    expect(wf).toMatch(/node scripts\/branch-cleanup\.mjs branches\.json pulls\.json/)
    expect(wf).toMatch(/dry_run:[\s\S]*?default: true/)
    expect(wf).toMatch(/permissions:\n\s+contents: write[^\n]*\n\s+pull-requests: read\n\n/)
  })
})
