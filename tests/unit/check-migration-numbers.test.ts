import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { checkMigrationNumbers, MIGRATIONS_DIR } from '../../scripts/check-migration-numbers.mjs'

const check = checkMigrationNumbers as (i: { head: string[]; base?: string[] | null; fork?: string[] | null }) => string[]
const upTo = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4, '0')}_m${i + 1}.sql`)

describe('check-migration-numbers', () => {
  it('passes on the repository as it stands', () => {
    expect(check({ head: readdirSync(MIGRATIONS_DIR as string) })).toEqual([])
  })

  it('the 2026-11-10 collision (#76 added 0024 after #75 had taken it): flagged with the fix', () => {
    const fork = [...upTo(23), 'README.md']
    const main = [...fork, '0024_cam_approve_atomic.sql']
    const branch = [...fork, '0024_gl_qb_account_type.sql']
    expect(check({ head: branch, base: main, fork })).toEqual([
      '0024_gl_qb_account_type.sql: number 0024 is already taken on the base by 0024_cam_approve_atomic.sql; renumber to 0025 (and its tests, README row and verify scripts)',
    ])
    // after renumbering and merging main, it passes
    expect(check({ head: [...main, '0025_gl_qb_account_type.sql'], base: main })).toEqual([])
  })

  it('a branch that is merely behind main is fine (main gained migrations after the fork)', () => {
    const fork = upTo(23)
    expect(check({ head: [...fork, '0024_mine.sql'], base: [...fork], fork })).toEqual([])
    expect(check({ head: fork, base: upTo(26), fork })).toEqual([])
  })

  it('a new migration reusing an old number is refused twice over: duplicate, and below the base tip', () => {
    const errs = check({ head: [...upTo(23), '0019_late.sql'], base: upTo(23) })
    expect(errs).toEqual([
      'migration number 0019 is used by 2 files: 0019_late.sql, 0019_m19.sql',
      '0019_late.sql: number 0019 is already taken on the base by 0019_m19.sql; renumber to 0024 (and its tests, README row and verify scripts)',
    ])
  })

  it('a new migration in a gap below the base tip is refused (numbers only grow)', () => {
    const base = upTo(23).filter((f) => !f.startsWith('0010'))
    expect(check({ head: [...base, '0010_gap.sql'], base })).toEqual([
      '0010_gap.sql: new migrations must be numbered above the base\'s highest (0023); renumber to 0024',
    ])
  })

  it('duplicate numbers in one tree (a clean merge of two 0025s) are refused', () => {
    expect(check({ head: [...upTo(24), '0025_a.sql', '0025_b.sql'] })).toEqual(['migration number 0025 is used by 2 files: 0025_a.sql, 0025_b.sql'])
  })

  it('deleting or renaming a migration that existed at the fork is refused', () => {
    const fork = upTo(5)
    const head = [...upTo(4), '0005_renamed.sql']
    const errs = check({ head, base: fork, fork })
    expect(errs.join('\n')).toMatch(/0005_m5\.sql is on the base branch but missing here/)
  })

  it('names must be NNNN_lower_snake.sql; README.md is ignored', () => {
    expect(check({ head: ['README.md', '0001_ok.sql', '2_bad.sql', '0003_Bad.sql', 'notes.txt'] })).toEqual([
      '2_bad.sql: migration files must be named NNNN_lower_snake_case.sql',
      '0003_Bad.sql: migration files must be named NNNN_lower_snake_case.sql',
      'notes.txt: migration files must be named NNNN_lower_snake_case.sql',
    ])
  })

  it('CI runs it on PRs (against the base) and on every branch push', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(ci).toMatch(/npm run check:migrations -- --base="refs\/remotes\/origin\/\$\{\{ github\.base_ref \}\}"/)
    const push = readFileSync('.github/workflows/migration-numbers.yml', 'utf8')
    expect(push).toMatch(/branches-ignore: \[main\]/)
    expect(push).toMatch(/node scripts\/check-migration-numbers\.mjs --base=refs\/remotes\/origin\/main/)
  })
})
