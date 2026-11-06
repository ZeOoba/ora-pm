/// <reference types="node" />
// tests/lib/admin-roles.test.ts
//
// P1 T12: the admin role vocabulary. server/lib/admin-roles.ts is what the middleware validates a
// stored admin_users.role against, and what later phases will enforce on — so it must never drift
// from the database CHECK that constrains the column.
import { describe, it, expect } from 'vitest'
import { allMigrationText } from '../fixtures/pg-migrations'
import { ADMIN_ROLES, isAdminRole } from '../../server/lib/admin-roles'

// --- drift tripwire parser ------------------------------------------------------------------------
// Reads every `admin_users_role_check CHECK (...)` definition from SQL text, in order, as its role
// list. Tolerant of layout (whitespace, newlines, keyword case, a quoted constraint name, redundant
// parentheses) and of both spellings Postgres accepts or prints: `role IN ('a', 'b')` and
// `role = ANY (ARRAY['a'::text, 'b'::text])` (pg_get_constraintdef / pg_dump). Anything else in a
// role CHECK throws: the tripwire must fail loudly, never skip or misread a definition.

// One string literal, optionally cast to text; a comma-separated list of them.
const LITERAL = String.raw`'(?:[^']|'')*'(?:\s*::\s*text)?`
const LIST = String.raw`${LITERAL}(?:\s*,\s*${LITERAL})*`
const IN_FORM = new RegExp(String.raw`^role\s+IN\s*\(\s*(${LIST})\s*\)$`, 'i')
const ANY_FORM = new RegExp(
  String.raw`^role\s*=\s*ANY\s*\(\s*(?:\(\s*)?ARRAY\s*\[\s*(${LIST})\s*\](?:\s*\))?(?:\s*::\s*text\s*\[\s*\])?\s*\)$`,
  'i',
)

// The text between the '(' at `open` and its matching ')', skipping parentheses inside literals.
function parenBody(text: string, open: number): string {
  let depth = 0
  let inLiteral = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inLiteral) {
      if (ch === "'") inLiteral = false // a '' escape closes and reopens: same net effect
    } else if (ch === "'") {
      inLiteral = true
    } else if (ch === '(') {
      depth++
    } else if (ch === ')' && --depth === 0) {
      return text.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced parentheses in admin_users_role_check: ${text.slice(open, open + 120)}`)
}

function stripOuterParens(expr: string): string {
  let e = expr.trim()
  while (e.startsWith('(') && parenBody(e, 0).length === e.length - 2) e = e.slice(1, -1).trim()
  return e
}

function parseRoleCheck(body: string): string[] {
  const expr = stripOuterParens(body)
  const list = IN_FORM.exec(expr)?.[1] ?? ANY_FORM.exec(expr)?.[1]
  if (list === undefined) {
    throw new Error(`unparseable admin_users_role_check: CHECK (${body.replace(/\s+/g, ' ').trim()})`)
  }
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
}

function roleCheckDefinitions(sql: string): string[][] {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  return [...code.matchAll(/\badmin_users_role_check"?\s+CHECK\s*\(/gi)].map((m) =>
    parseRoleCheck(parenBody(code, m.index + m[0].length - 1)),
  )
}

describe('admin role vocabulary (T12)', () => {
  it('is exactly owner, manager, bookkeeper, viewer', () => {
    expect([...ADMIN_ROLES]).toEqual(['owner', 'manager', 'bookkeeper', 'viewer'])
  })

  it('mirrors the admin_users.role CHECK in the migrations (drift tripwire)', () => {
    // The LAST definition across all migrations wins, so a later migration that changes the CHECK
    // is compared here too — update ADMIN_ROLES in the same PR.
    const defs = roleCheckDefinitions(allMigrationText())
    expect(
      defs.length,
      'no admin_users_role_check CHECK found in supabase/migrations: the drift tripwire has nothing to compare',
    ).toBeGreaterThan(0)
    expect(defs[defs.length - 1]).toEqual([...ADMIN_ROLES])
  })

  it('isAdminRole accepts each role', () => {
    for (const role of ADMIN_ROLES) expect(isAdminRole(role)).toBe(true)
  })

  it('isAdminRole rejects anything else — case variants, padding, blanks and non-strings', () => {
    for (const value of ['admin', 'Owner', 'OWNER', ' owner', 'owner ', '', null, undefined, 0, 1, true, {}, [], ['owner']]) {
      expect(isAdminRole(value), JSON.stringify(value) ?? String(value)).toBe(false)
    }
  })
})

describe('roleCheckDefinitions — the drift tripwire parser', () => {
  it('reads the one-line IN form', () => {
    expect(roleCheckDefinitions(`CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'viewer'))`)).toEqual([
      ['owner', 'viewer'],
    ])
  })

  it('tolerates whitespace and newlines anywhere, and lower-case keywords', () => {
    const sql = `role TEXT NOT NULL
      CONSTRAINT admin_users_role_check
        check (
          role   in (
            'owner',
            'manager' ,'viewer'
          )
        ),`
    expect(roleCheckDefinitions(sql)).toEqual([['owner', 'manager', 'viewer']])
  })

  it('reads the = ANY (ARRAY[...]) form, with or without casts and redundant parentheses', () => {
    expect(roleCheckDefinitions(`ADD CONSTRAINT admin_users_role_check CHECK (role = ANY (ARRAY['owner', 'viewer']))`)).toEqual([
      ['owner', 'viewer'],
    ])
    // pg_dump / pg_get_constraintdef output
    expect(
      roleCheckDefinitions(
        `CONSTRAINT admin_users_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'bookkeeper'::text, 'viewer'::text])))`,
      ),
    ).toEqual([['owner', 'manager', 'bookkeeper', 'viewer']])
    expect(
      roleCheckDefinitions(`CONSTRAINT "admin_users_role_check" CHECK (role=ANY(ARRAY['owner'::text,'viewer'::text]::text[]))`),
    ).toEqual([['owner', 'viewer']])
  })

  it('ignores definitions inside SQL comments', () => {
    const sql = `-- was: CONSTRAINT admin_users_role_check CHECK (role IN ('admin'))
      /* CONSTRAINT admin_users_role_check CHECK (role IN ('root')) */
      CONSTRAINT admin_users_role_check CHECK (role IN ('owner'))`
    expect(roleCheckDefinitions(sql)).toEqual([['owner']])
  })

  it('returns every definition in file order (the tripwire compares the last one)', () => {
    const sql = `CONSTRAINT admin_users_role_check CHECK (role IN ('owner'));
      ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check,
        ADD CONSTRAINT admin_users_role_check CHECK (role = ANY (ARRAY['owner', 'auditor']));`
    expect(roleCheckDefinitions(sql)).toEqual([['owner'], ['owner', 'auditor']])
  })

  it('finds nothing in SQL without the constraint, so the tripwire fails loudly', () => {
    expect(roleCheckDefinitions(`CREATE TABLE admin_users (role TEXT NOT NULL);`)).toEqual([])
  })

  it('throws on a role CHECK it cannot read, rather than skipping it or misreading it', () => {
    expect(() => roleCheckDefinitions(`CONSTRAINT admin_users_role_check CHECK (role IS NOT NULL)`)).toThrow(
      /unparseable admin_users_role_check/,
    )
    expect(() =>
      roleCheckDefinitions(`CONSTRAINT admin_users_role_check CHECK (role IN ('owner') OR role LIKE 'x%')`),
    ).toThrow(/unparseable admin_users_role_check/)
    expect(() => roleCheckDefinitions(`CONSTRAINT admin_users_role_check CHECK (role IN ('owner', viewer))`)).toThrow(
      /unparseable admin_users_role_check/,
    )
    expect(() => roleCheckDefinitions(`CONSTRAINT admin_users_role_check CHECK (role IN ('owner')`)).toThrow(
      /unbalanced/,
    )
  })
})
