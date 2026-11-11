// Branch cleanup for .github/workflows/branch-cleanup.yml (the agent proxy cannot delete branches,
// so this runs in GitHub Actions with the repository's own token).
//
// A branch is deleted only when nothing on it can be lost:
//   - merged:  a merged PR's head commit IS the branch tip (nothing pushed after the merge);
//   - closed:  a PR closed without merging, closed more than STALE_DAYS ago, whose head commit is
//              the branch tip (abandoned, nothing pushed since);
// and never when it is the default branch, protected, has an open PR, has no PR at all (work in
// progress), or has commits newer than its last PR. `explicit` names extra branches to delete on a
// manual run (still never the default, a protected branch, or one with an open PR).
//
// CLI: node scripts/branch-cleanup.mjs <branches.json> <pulls.json> <default-branch> [explicit...]
//   branches.json: [{ name, commit: { sha }, protected }]   (GET /repos/{r}/branches, all pages)
//   pulls.json:    [{ number, state, merged_at, closed_at, head: { ref, sha, repo: { full_name } } }]
//   Prints one branch name per line to delete; reasons go to stderr.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const STALE_DAYS = 14

/**
 * @param {{ branches: any[], pulls: any[], defaultBranch: string, repo: string, now?: Date, explicit?: string[] }} input
 * @returns {{ delete: { name: string, reason: string }[], keep: { name: string, reason: string }[] }}
 */
export function planCleanup({ branches, pulls, defaultBranch, repo, now = new Date(), explicit = [] }) {
  const own = pulls.filter((p) => p.head?.repo?.full_name === repo)
  const byRef = new Map()
  for (const p of own) {
    const list = byRef.get(p.head.ref) ?? []
    list.push(p)
    byRef.set(p.head.ref, list)
  }
  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000
  const wanted = new Set(explicit)
  const out = { delete: [], keep: [] }
  for (const b of branches) {
    const name = b.name
    const tip = b.commit?.sha
    const prs = byRef.get(name) ?? []
    const keep = (reason) => out.keep.push({ name, reason })
    if (name === defaultBranch) { keep('default branch'); continue }
    if (b.protected) { keep('protected'); continue }
    if (prs.some((p) => p.state === 'open')) { keep(`open PR #${prs.find((p) => p.state === 'open').number}`); continue }
    if (wanted.has(name)) { out.delete.push({ name, reason: 'named on a manual run' }); continue }
    if (!prs.length) { keep('no PR (possible work in progress)'); continue }
    const merged = prs.find((p) => p.merged_at && p.head.sha === tip)
    if (merged) { out.delete.push({ name, reason: `PR #${merged.number} merged; tip is its head` }); continue }
    const closed = prs.find((p) => !p.merged_at && p.closed_at && p.head.sha === tip)
    if (closed && Date.parse(closed.closed_at) < staleBefore) {
      out.delete.push({ name, reason: `PR #${closed.number} closed unmerged ${closed.closed_at.slice(0, 10)}; tip is its head` })
      continue
    }
    keep(closed ? `PR #${closed.number} closed less than ${STALE_DAYS} days ago` : 'commits after its last PR')
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [branchesFile, pullsFile, defaultBranch, ...explicit] = process.argv.slice(2)
  const repo = process.env.GITHUB_REPOSITORY
  if (!branchesFile || !pullsFile || !defaultBranch || !repo) {
    console.error('usage: GITHUB_REPOSITORY=owner/repo node scripts/branch-cleanup.mjs <branches.json> <pulls.json> <default-branch> [explicit...]')
    process.exit(2)
  }
  const flat = (f) => JSON.parse(readFileSync(f, 'utf8')).flat() // gh api --paginate --slurp gives pages
  const plan = planCleanup({ branches: flat(branchesFile), pulls: flat(pullsFile), defaultBranch, repo, explicit: explicit.filter(Boolean) })
  for (const k of plan.keep) console.error(`keep    ${k.name}  (${k.reason})`)
  for (const d of plan.delete) console.error(`delete  ${d.name}  (${d.reason})`)
  for (const d of plan.delete) console.log(d.name)
}
