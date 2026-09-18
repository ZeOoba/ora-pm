// OI-312: the deploy gate is only as good as its parser. A parser that silently returns "nothing
// pending" on output it didn't understand would reintroduce exactly the ungated deploy it exists to
// prevent, so the unparseable cases are pinned as hard as the pending ones.
import { describe, it, expect } from 'vitest'
import { parseMigrationList } from '../../scripts/check-migrations-applied.mjs'

const BOX = `        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼─────────────────────
    20260916000000 │ 20260916000000 │ 2026-09-16 00:00:00
    20260917000000 │ 20260917000000 │ 2026-09-17 00:00:00`

const ASCII = `  LOCAL          | REMOTE         | TIME (UTC)
  --------------+----------------+------------
  20260916000000 | 20260916000000 | 2026-09-16`

// VERBATIM output from `supabase migration list --linked` on this repo, captured from
// run 35388593228 (2026-09-18). The versions are BACKTICK-WRAPPED and the repo uses sequential
// numbering, not Supabase's default 14-digit timestamps. The first version of this gate assumed
// bare digits, parsed zero rows against this exact text, and blocked the deploy on the first push
// to main that ran it. This fixture is the regression: if the parser ever stops understanding real
// production output again, this test fails instead of the deploy.
const REAL_CLI_OUTPUT = [
  '   Local  | Remote | Time (UTC) ',
  '  --------|--------|------------',
  '   `0015` | `0015` | `0015`     ',
  '   `0016` | `0016` | `0016`     ',
  '   `0017` | `0017` | `0017`     ',
].join('\n')

describe('parseMigrationList — real CLI output (OI-312 regression)', () => {
  it('parses the verbatim backtick-wrapped production table and reports nothing pending', () => {
    const { pending, sawAnyRow } = parseMigrationList(REAL_CLI_OUTPUT)
    expect(sawAnyRow).toBe(true)
    expect(pending).toEqual([])
  })

  it('flags a pending migration in the real backtick format (blank remote cell)', () => {
    const { pending, sawAnyRow } = parseMigrationList(`${REAL_CLI_OUTPUT}
   \`0018\` |        | \`0018\`     `)
    expect(sawAnyRow).toBe(true)
    expect(pending).toEqual(['0018'])
  })

  it('does not mistake the real header or ASCII rule row for a migration', () => {
    expect(parseMigrationList(REAL_CLI_OUTPUT).pending).not.toContain('Local')
    const headerAndRuleOnly = REAL_CLI_OUTPUT.split(String.fromCharCode(10)).slice(0, 2).join(String.fromCharCode(10))
    expect(parseMigrationList(headerAndRuleOnly).sawAnyRow).toBe(false)
  })
})

describe('parseMigrationList (OI-312 deploy gate)', () => {
  it('reports nothing pending when every local migration has a remote entry', () => {
    const { pending, sawAnyRow } = parseMigrationList(BOX)
    expect(sawAnyRow).toBe(true)
    expect(pending).toEqual([])
  })

  it('flags a local migration with a blank remote cell as pending', () => {
    const { pending } = parseMigrationList(`${BOX}\n    20260918000000 │                │ 2026-09-18 00:00:00`)
    expect(pending).toEqual(['20260918000000'])
  })

  it('flags several pending migrations in order', () => {
    const out = `${BOX}
    20260918000000 │                │ 2026-09-18 00:00:00
    20260919000000 │                │ 2026-09-19 00:00:00`
    expect(parseMigrationList(out).pending).toEqual(['20260918000000', '20260919000000'])
  })

  it('handles the ASCII-separator CLI variant as well as the box-drawing one', () => {
    const { pending, sawAnyRow } = parseMigrationList(ASCII)
    expect(sawAnyRow).toBe(true)
    expect(pending).toEqual([])
  })

  it('does not mistake the header or the horizontal rule for a migration row', () => {
    const { pending, sawAnyRow } = parseMigrationList(BOX)
    expect(sawAnyRow).toBe(true)
    expect(pending).not.toContain('LOCAL')
  })

  // The fail-closed contract: the caller treats sawAnyRow === false as "refuse to deploy".
  it('reports sawAnyRow false on empty output, so the caller fails closed instead of reading it as "all applied"', () => {
    expect(parseMigrationList('').sawAnyRow).toBe(false)
  })

  it('reports sawAnyRow false on unrecognised output rather than silently passing the deploy', () => {
    expect(parseMigrationList('Cannot find project ref. Have you run supabase link?').sawAnyRow).toBe(false)
  })

  it('reports sawAnyRow false on a header-only table (no migrations returned at all)', () => {
    const headerOnly = `        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼─────────────────────`
    expect(parseMigrationList(headerOnly).sawAnyRow).toBe(false)
  })

  it('ignores a remote-only row (applied remotely, file deleted locally) — that is not a pending deploy hazard', () => {
    const out = `${BOX}\n                   │ 20260915000000 │ 2026-09-15 00:00:00`
    expect(parseMigrationList(out).pending).toEqual([])
  })
})
