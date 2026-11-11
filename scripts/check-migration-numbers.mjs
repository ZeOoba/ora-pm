#!/usr/bin/env node
// Migration-number collision gate.
//
// Two sessions can pick the same next number in parallel (2026-11-10: #75 and #76 both shipped a
// 0024). When that happens the PR usually conflicts with main, GitHub skips its pull_request CI,
// and the collision shows up only as "no checks". This script fails loudly instead:
//
//   1. every file in supabase/migrations/ except README.md is named NNNN_lower_snake.sql;
//   2. no two migrations share a number;
//   3. compared with --base (main): every migration the branch ADDS is numbered above every
//      migration on the base's tip, and no migration that existed where the branch forked from
//      the base was deleted or renamed (it may already be applied to production). A branch that
//      is merely behind the base is fine: migrations added to the base later are not "missing".
//
// Usage: node scripts/check-migration-numbers.mjs [--base=<git ref>]
// Without --base only checks 1–2 run. With --base it FAILS CLOSED if the ref does not resolve.
// No dependencies (runs before `npm ci` in .github/workflows/migration-numbers.yml).
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MIGRATIONS_DIR = 'supabase/migrations'
const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/
const IGNORED = new Set(['README.md'])

/**
 * @param {{ head: string[], base?: string[] | null, fork?: string[] | null }} input file names
 *   (not paths) in the migrations directory on the branch, on the base ref's tip, and at the
 *   merge base of the two (defaults to `base` when not given)
 * @returns {string[]} problems; empty means OK
 */
export function checkMigrationNumbers({ head, base = null, fork = null }) {
  const errors = []
  const files = head.filter((f) => !IGNORED.has(f))
  const byNumber = new Map()
  for (const f of files) {
    const m = NAME_RE.exec(f)
    if (!m) {
      errors.push(`${f}: migration files must be named NNNN_lower_snake_case.sql`)
      continue
    }
    const list = byNumber.get(m[1]) ?? []
    list.push(f)
    byNumber.set(m[1], list)
  }
  for (const [num, list] of [...byNumber].sort()) {
    if (list.length > 1) errors.push(`migration number ${num} is used by ${list.length} files: ${list.sort().join(', ')}`)
  }
  if (base) {
    const baseFiles = base.filter((f) => NAME_RE.test(f))
    const headSet = new Set(files)
    const baseMax = baseFiles.reduce((mx, f) => Math.max(mx, Number(f.slice(0, 4))), 0)
    for (const f of (fork ?? base).filter((x) => NAME_RE.test(x))) {
      if (!headSet.has(f)) errors.push(`${f} is on the base branch but missing here: an applied migration must never be deleted or renamed`)
    }
    const baseSet = new Set([...baseFiles, ...(fork ?? [])])
    for (const f of files.filter((x) => !baseSet.has(x) && NAME_RE.test(x)).sort()) {
      const n = Number(f.slice(0, 4))
      if (n <= baseMax) {
        const taken = baseFiles.filter((b) => Number(b.slice(0, 4)) === n)
        const next = String(baseMax + 1).padStart(4, '0')
        errors.push(taken.length
          ? `${f}: number ${f.slice(0, 4)} is already taken on the base by ${taken.join(', ')}; renumber to ${next} (and its tests, README row and verify scripts)`
          : `${f}: new migrations must be numbered above the base's highest (${String(baseMax).padStart(4, '0')}); renumber to ${next}`)
      }
    }
  }
  return errors
}

function gitLsTree(ref) {
  const out = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${MIGRATIONS_DIR}`], { encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

function main(argv) {
  const baseArg = argv.find((a) => a.startsWith('--base='))
  const baseRef = baseArg ? baseArg.slice('--base='.length) : null
  const head = readdirSync(MIGRATIONS_DIR)
  let base = null
  let fork = null
  if (baseRef !== null) {
    if (!baseRef) {
      console.error('check:migrations — --base is empty; refusing to skip the comparison (fail closed)')
      return 1
    }
    try {
      base = gitLsTree(baseRef)
      const mergeBase = execFileSync('git', ['merge-base', baseRef, 'HEAD'], { encoding: 'utf8' }).trim()
      fork = gitLsTree(mergeBase)
    } catch {
      console.error(`check:migrations — base ref "${baseRef}" (or its merge base with HEAD) does not resolve; fetch it with full history first (fail closed)`)
      return 1
    }
  }
  const errors = checkMigrationNumbers({ head, base, fork })
  if (errors.length) {
    console.error('check:migrations — FAILED')
    for (const e of errors) console.error(`  - ${e}`)
    return 1
  }
  const count = head.filter((f) => NAME_RE.test(f)).length
  console.log(`check:migrations — OK: ${count} migrations, numbers unique${base ? `, new ones above ${baseRef}` : ''}.`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
