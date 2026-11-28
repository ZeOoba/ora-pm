/// <reference types="node" />
// tests/db/code-columns-exist.test.ts
//
// Every column the app's Supabase calls name must exist once every migration in supabase/migrations has been
// applied to real PostgreSQL (PGlite).
//
// Why: ci.yml's "Check migrations are applied" step (OI-312) refuses a deploy while any migration FILE in the
// repo is unapplied in production. It cannot see code that reads or writes a column that NO migration creates:
// a typo, a migration left out of the PR, or a column added by hand in the dashboard. That passes the gate and
// fails in production with 42703 (undefined_column). This test is the other half: the code's columns must
// come from a migration in the repo.
//
// What is checked (tests/fixtures/code-columns.ts): `.from('<table>')` chains in server/, functions/ and src/
// — select lists (with embedded resources), filter and order columns, and the keys of insert/update/upsert
// payloads. Tables chosen at run time are skipped and counted; the coverage floor below keeps the check from
// quietly shrinking to nothing.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { extractColumnRefs, parseSelect, type Extraction } from '../fixtures/code-columns'

const ROOT = join(__dirname, '../..')
const DIR = join(ROOT, 'supabase/migrations')
const STUBS = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
`

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...sourceFiles(p)) }
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const SOURCES = ['server', 'functions', 'src'].flatMap((d) => sourceFiles(join(ROOT, d)))
  .map((p) => ({ file: relative(ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }))

type Schema = { columns: Map<string, Set<string>>; fks: { from: string; to: string; name: string; cols: string[] }[] }
let db: PGlite
let schema: Schema

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(STUBS)
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(join(DIR, f), 'utf8'))
  const cols = await db.query<{ t: string; c: string }>(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`)
  const columns = new Map<string, Set<string>>()
  for (const { t, c } of cols.rows) (columns.get(t) ?? columns.set(t, new Set()).get(t)!).add(c)
  const fk = await db.query<{ src: string; dst: string; name: string; cols: string[] }>(`
    SELECT c.conrelid::regclass::text AS src, c.confrelid::regclass::text AS dst, c.conname AS name,
           array(SELECT a.attname::text FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)
  schema = { columns, fks: fk.rows.map((r) => ({ from: r.src, to: r.dst, name: r.name, cols: r.cols })) }
}, 120_000)
afterAll(async () => { await db?.close() })

/**
 * Checks an extraction against the migrated schema; returns one line per problem. An embedded resource names
 * a table, an FK constraint, or an FK column of its parent (PostgREST's three spellings); each resolves to the
 * table whose columns the embed's own list then names.
 */
function problems(x: Extraction, s: Schema): string[] {
  const out: string[] = []
  const real = new Map<string, string>() // `${file}:${line}:${rawName}` → table
  const resolve = (file: string, line: number, raw: string) => (s.columns.has(raw) ? raw : real.get(`${file}:${line}:${raw}`))
  for (const e of x.embeds) {
    const parent = resolve(e.file, e.line, e.parent)
    if (parent === undefined) continue // reported via the parent's own refs
    let to: string | undefined
    if (s.columns.has(e.name)) to = e.name
    else to = s.fks.find((f) => f.from === parent && (f.name === e.name || (f.cols.length === 1 && f.cols[0] === e.name)))?.to
    if (to === undefined) out.push(`${e.file}:${e.line}  embed ${e.name} under ${parent}: no such table or foreign key`)
    else real.set(`${e.file}:${e.line}:${e.name}`, to)
  }
  for (const r of x.refs) {
    const table = resolve(r.file, r.line, r.table)
    if (table === undefined) {
      if (!x.embeds.some((e) => e.file === r.file && e.line === r.line && e.name === r.table)) out.push(`${r.file}:${r.line}  ${r.via} on ${r.table}: no such table or view`)
      continue
    }
    if (!s.columns.get(table)!.has(r.column)) out.push(`${r.file}:${r.line}  ${r.via} ${table}.${r.column}: no migration creates this column`)
  }
  return [...new Set(out)]
}

describe('parseSelect', () => {
  it('reads columns, aliases, casts, JSON paths, embeds, hints and spreads', () => {
    expect(parseSelect('id, total:amount::text, raw->>k, *, leases!inner(id, tenants(name)), ...units(suite), count()')).toEqual([
      { column: 'id' }, { column: 'amount' }, { column: 'raw' },
      { embed: 'leases', items: [{ column: 'id' }, { embed: 'tenants', items: [{ column: 'name' }] }] },
      { embed: 'units', items: [{ column: 'suite' }] },
    ])
  })
  it('refuses unbalanced parentheses', () => {
    expect(() => parseSelect('id, units(suite')).toThrow(/unbalanced/)
  })
})

describe('the check itself', () => {
  it('flags an unknown column in a select, a filter, an embed and a write payload; passes real ones', () => {
    const x = extractColumnRefs([{ file: 'x.ts', text: `
      const COLS = ['id', 'no_such_select'].join(', ')
      db.from('leases').select(COLS).eq('no_such_filter', 1).order('start_date')
      db.from('leases').select('id, units(suite, no_such_embed_col)')
      db.from('leases').update({ status: 'active', no_such_write: 1 }).eq('id', x)
      db.from('no_such_table').select('id')
      db.from(pick()).select('id')
      supabase.storage.from('insurance-certs').update('p', f)
    ` }])
    expect(problems(x, schema).map((p) => p.replace(/^x\.ts:\d+\s+/, ''))).toEqual([
      'select leases.no_such_select: no migration creates this column',
      'eq leases.no_such_filter: no migration creates this column',
      'select units.no_such_embed_col: no migration creates this column',
      'update leases.no_such_write: no migration creates this column',
      'select on no_such_table: no such table or view',
    ])
    expect(x.unresolved).toEqual([{ file: 'x.ts', line: 7, what: 'table of .select()' }])
  })

  it('follows a named helper to its call sites (the billing schedule read goes through one)', () => {
    const x = extractColumnRefs([{ file: 'h.ts', text: `
      const COLS = 'lease_id, no_such_helper_col'
      const page = (table: string, cols: string) => fetchAll((after) => db.from(table).select(\`id, \${cols}\`))
      page('lease_recurring_charges', COLS)
    ` }])
    expect(x.unresolved).toEqual([])
    expect(problems(x, schema).map((p) => p.replace(/^h\.ts:\d+\s+/, ''))).toEqual([
      'select lease_recurring_charges.no_such_helper_col: no migration creates this column',
    ])
  })
})

describe('every column the app names exists after all migrations', () => {
  it('has no column, table or embed that no migration creates', () => {
    const x = extractColumnRefs(SOURCES)
    expect(problems(x, schema)).toEqual([])
  })

  it('still covers the app (a parser regression would otherwise pass silently)', () => {
    const x = extractColumnRefs(SOURCES)
    const tables = new Set(x.refs.map((r) => r.table))
    // Floors sit below today's counts; raise them when coverage grows, never lower them to pass.
    expect(x.refs.length).toBeGreaterThanOrEqual(FLOOR_REFS)
    expect(tables.size).toBeGreaterThanOrEqual(FLOOR_TABLES)
    // billing reads these through exported constants; losing them means constant resolution broke.
    for (const c of ['charge_code', 'amount_monthly', 'superseded_at']) expect(x.refs.some((r) => r.table === 'lease_recurring_charges' && r.column === c)).toBe(true)
  })
})

// Measured 2026-11-28: 748 refs across 37 tables (36 calls skipped: run-time tables or payload variables).
const FLOOR_REFS = 700
const FLOOR_TABLES = 35
