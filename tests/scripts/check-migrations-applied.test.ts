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
