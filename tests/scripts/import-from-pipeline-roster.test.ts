// tests/scripts/import-from-pipeline-roster.test.ts
//
// The repository is public. scripts/import-from-pipeline.mjs used to hardcode the owned-property
// roster (street addresses) and a comment naming a seller-financing counterparty and its note
// payment. The roster now lives in a gitignored local file (scripts/pipeline-properties.local.json,
// shape in the committed .example.json) and the importer fails closed without it.
//
// Two layers, and this file carries none of the real values, not even as hashes (an unkeyed hash
// of a short identifier is recoverable by brute force):
//   * structural checks, always on (CI included): no street address or inline roster in the
//     importer, the loader is used, the private files are gitignored and untracked;
//   * the identifier scan: every tracked text file against the private list in
//     scripts/banned-identifiers.local.json (gitignored; or the path in ORA_PM_BANNED_IDENTIFIERS).
//     Where that list is absent (CI, fresh clones) the scan is reported as SKIPPED, never passed.

import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXAMPLE_PROPERTIES_PATH,
  PropertyConfigError,
  loadPropertyConfig,
  parsePropertyConfig,
} from '../../scripts/pipeline-properties.mjs'

const ROOT = join(__dirname, '../..')
const IMPORTER = join(ROOT, 'scripts/import-from-pipeline.mjs')
const LOADER = join(ROOT, 'scripts/pipeline-properties.mjs')
const BANNED_EXAMPLE = join(ROOT, 'scripts/banned-identifiers.example.json')
const BANNED_LOCAL = process.env.ORA_PM_BANNED_IDENTIFIERS || join(ROOT, 'scripts/banned-identifiers.local.json')

// A US street address: house number, optional direction, one to four capitalized words, a suffix.
const STREET_ADDRESS =
  /\b\d{1,6}(?:-\d{1,6})?\s+(?:[NSEW]\.?\s+)?(?:[A-Z0-9][A-Za-z0-9]*\s+){1,4}(?:Rd|Road|Ave|Avenue|St|Street|Dr|Drive|Hwy|Highway|Ct|Court|Ln|Lane|Blvd|Boulevard|Way|Pkwy|Parkway|Pl|Place|Cir|Circle|Route)\b/

// ── banned-identifier scan ─────────────────────────────────────────────────────
type BannedTerm = { term: string; exemptPathPrefixes?: string[] }
type CompiledTerm = { index: number; norm: string; exempt: string[] }
const MAX_NGRAM = 8

function tokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Parse a banned-identifier list. Malformed => throw (a present-but-broken list must not skip). */
function compileBanned(raw: unknown, source: string): CompiledTerm[] {
  const terms = (raw as { terms?: unknown })?.terms
  if (!Array.isArray(terms) || terms.length === 0) throw new Error(`${source}: "terms" must be a non-empty array`)
  return terms.map((t: BannedTerm, index) => {
    if (!t || typeof t.term !== 'string') throw new Error(`${source}: terms[${index}].term must be a string`)
    const norm = tokens(t.term).join('')
    if (norm.length < 4) throw new Error(`${source}: terms[${index}] is too short to scan for safely`)
    const exempt = t.exemptPathPrefixes ?? []
    if (!Array.isArray(exempt) || exempt.some((p) => typeof p !== 'string')) {
      throw new Error(`${source}: terms[${index}].exemptPathPrefixes must be an array of strings`)
    }
    return { index, norm, exempt }
  })
}

/** Indices of the terms found in `text` (1..MAX_NGRAM adjacent tokens, joined, compared). */
function bannedHits(text: string, terms: CompiledTerm[]): number[] {
  const byNorm = new Map(terms.map((t) => [t.norm, t.index]))
  const lens = new Set(terms.map((t) => t.norm.length))
  const maxLen = Math.max(...lens)
  const toks = tokens(text)
  const hits = new Set<number>()
  for (let i = 0; i < toks.length; i++) {
    let joined = ''
    for (let n = 0; n < MAX_NGRAM && i + n < toks.length; n++) {
      joined += toks[i + n]
      if (joined.length > maxLen) break
      if (lens.has(joined.length) && byNorm.has(joined)) hits.add(byNorm.get(joined)!)
    }
  }
  return [...hits]
}

function trackedTextFiles(): { path: string; text: string }[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
  const out: { path: string; text: string }[] = []
  for (const f of files) {
    if (f === 'package-lock.json') continue // registry-generated, multi-MB
    let buf: Buffer
    try {
      buf = readFileSync(join(ROOT, f))
    } catch {
      continue // deleted in the working tree
    }
    if (buf.includes(0)) continue // binary
    out.push({ path: f, text: buf.toString('utf8') })
  }
  return out
}

describe('banned-identifier scan: mechanism (always on, synthetic list)', () => {
  const terms = compileBanned(JSON.parse(readFileSync(BANNED_EXAMPLE, 'utf8')), 'banned-identifiers.example.json')

  it('matches regardless of case, punctuation, spacing and line wraps', () => {
    expect(bannedHits('// sold to EXAMPLE-holding_trust, see note', terms)).toEqual([0])
    expect(bannedHits('the "$12,345/mo" is a loan payment', terms)).toEqual([2])
    expect(bannedHits('label: 9999\n  Sample', terms)).toEqual([1])
    expect(bannedHits('Example holding company trust; 12,3456', terms)).toEqual([])
  })

  it('rejects a malformed or too-short list instead of skipping', () => {
    expect(() => compileBanned({}, 'x')).toThrow(/non-empty array/)
    expect(() => compileBanned({ terms: [{ term: 'ab' }] }, 'x')).toThrow(/too short/)
    expect(() => compileBanned({ terms: [{ term: 'abcd', exemptPathPrefixes: 'x' }] }, 'x')).toThrow(/exemptPathPrefixes/)
  })
})

const haveLocalList = existsSync(BANNED_LOCAL)
if (!haveLocalList) {
  console.warn(
    `[import-from-pipeline-roster] SKIPPED the tracked-file identifier scan: ${BANNED_LOCAL} not found. ` +
      'Copy scripts/banned-identifiers.example.json to scripts/banned-identifiers.local.json and fill it to enable it.',
  )
}

describe('banned-identifier scan: tracked files vs the private local list', () => {
  it.skipIf(!haveLocalList)(
    'no tracked text file contains a private identifier (outside its exempt paths)',
    { timeout: 120_000 },
    () => {
      const terms = compileBanned(JSON.parse(readFileSync(BANNED_LOCAL, 'utf8')), BANNED_LOCAL)
      const files = trackedTextFiles()
      expect(files.length).toBeGreaterThan(50)
      const offenders: string[] = []
      for (const { path, text } of files) {
        const applicable = terms.filter((t) => !t.exempt.some((p) => path.startsWith(p)))
        if (!applicable.length) continue
        // Report the file and the term's index in the local list, never the term itself.
        for (const i of bannedHits(text, applicable)) offenders.push(`${path} (local term #${i})`)
      }
      expect(offenders).toEqual([])
    },
  )
})

describe('import-from-pipeline: no roster in public source (structural, always on)', () => {
  const src = readFileSync(IMPORTER, 'utf8')

  it('the importer and its loader contain no street address', () => {
    expect(src).not.toMatch(STREET_ADDRESS)
    expect(readFileSync(LOADER, 'utf8')).not.toMatch(STREET_ADDRESS)
  })

  it('the importer has no inline property map or hardcoded exclusion labels', () => {
    expect(src).not.toMatch(/PROPERTY_META\s*=\s*\{/)
    expect(src).not.toMatch(/new Set\(\s*\[\s*['"`]/)
    expect(src).toMatch(/loadPropertyConfig\(/)
  })

  it('the private roster and identifier list are gitignored and untracked', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim())
    for (const p of ['scripts/pipeline-properties.local.json', 'scripts/banned-identifiers.local.json']) {
      expect(ignore).toContain(p)
      const tracked = execFileSync('git', ['ls-files', p], { cwd: ROOT, encoding: 'utf8' })
      expect(tracked.trim()).toBe('')
    }
  })

  it('no committed test carries a digest of a private identifier', () => {
    // Unkeyed digests of short identifiers are brute-forceable; the list lives off-repo instead.
    expect(readFileSync(__filename, 'utf8')).not.toMatch(/['"][0-9a-f]{64}['"]/)
  })
})

describe('import-from-pipeline: fails closed without the local roster', () => {
  it('exits 2 with a pointer to the example before reading .env or the rent roll', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ora-pm-roster-'))
    const r = spawnSync(
      process.execPath,
      [IMPORTER, '--file', join(dir, 'TENANTS.json'), '--all', '--dry-run', '--properties', join(dir, 'missing.json')],
      { cwd: dir, encoding: 'utf8' },
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/pipeline-properties\.example\.json/)
    expect(r.stderr).not.toMatch(/SUPABASE|TENANTS\.json/)
  })

  it('refuses the committed example as a real roster', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ora-pm-roster-'))
    const r = spawnSync(
      process.execPath,
      [IMPORTER, '--file', join(dir, 'TENANTS.json'), '--all', '--dry-run', '--properties', EXAMPLE_PROPERTIES_PATH],
      { cwd: dir, encoding: 'utf8' },
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/_example/)
  })
})

describe('pipeline-properties loader', () => {
  it('loads the committed example only when explicitly allowed, and it is synthetic', () => {
    expect(() => loadPropertyConfig(EXAMPLE_PROPERTIES_PATH)).toThrow(PropertyConfigError)
    const { PROPERTY_META, EXCLUDE } = loadPropertyConfig(EXAMPLE_PROPERTIES_PATH, { allowExample: true })
    const metas = Object.values(PROPERTY_META)
    expect(metas.length).toBeGreaterThan(0)
    for (const m of metas) {
      expect(`${m.name} ${m.address} ${m.city}`).toMatch(/Example|Sample/)
      expect(m.zip === null || m.zip === '00000').toBe(true)
    }
    for (const label of EXCLUDE.keys()) expect(label).toMatch(/Example|Sample/)
  })

  it('fails closed on a missing file with a pointer to the example', () => {
    expect(() => loadPropertyConfig(join(tmpdir(), 'ora-pm-no-such-roster.json'))).toThrow(
      /pipeline-properties\.example\.json/,
    )
  })

  it('fails closed on unreadable JSON', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ora-pm-roster-')), 'bad.json')
    writeFileSync(p, '{ not json')
    expect(() => loadPropertyConfig(p)).toThrow(/not readable JSON/)
  })

  const good = { name: '1 Test Rd', address: '1 Test Rd', city: 'Testville', state: 'OH', zip: null, property_type: 'industrial', entity_llc: null }

  it('returns PROPERTY_META and an EXCLUDE map', () => {
    const { PROPERTY_META, EXCLUDE } = parsePropertyConfig({ properties: { T: good }, exclude: { X: 'sold' } })
    expect((PROPERTY_META as Record<string, unknown>).T).toEqual(good)
    expect(EXCLUDE.get('X')).toBe('sold')
  })

  // A copy of the example with the marker flipped, stringified or deleted must still be refused.
  const example = JSON.parse(readFileSync(EXAMPLE_PROPERTIES_PATH, 'utf8'))
  const { _example: _drop, ...exampleWithoutMarker } = example

  it.each([
    ['not an object', []],
    ['no properties', {}],
    ['empty properties', { properties: {} }],
    ['unknown column (would be inserted into properties)', { properties: { T: { ...good, total_sf: 1 } } }],
    ['bad state', { properties: { T: { ...good, state: 'Ohio' } } }],
    ['bad zip', { properties: { T: { ...good, zip: '123' } } }],
    ['missing name', { properties: { T: { ...good, name: '' } } }],
    ['exclude without reason', { properties: { T: good }, exclude: { X: '' } }],
    ['label both included and excluded', { properties: { T: good }, exclude: { T: 'sold' } }],
    ['_example: "true" (string)', { ...example, _example: 'true' }],
    ['_example: 1', { ...example, _example: 1 }],
    ['_example: false (key present at all)', { properties: { T: good }, _example: false }],
    ['the example with _example deleted', exampleWithoutMarker],
    ['a synthetic name', { properties: { T: { ...good, name: '9 Example Rd' } } }],
    ['a synthetic address', { properties: { T: { ...good, address: '9 sample st' } } }],
    ['a synthetic city', { properties: { T: { ...good, city: 'Exampleton Example' } } }],
    ['the placeholder zip 00000', { properties: { T: { ...good, zip: '00000' } } }],
  ])('rejects %s', (_why, cfg) => {
    expect(() => parsePropertyConfig(cfg)).toThrow(PropertyConfigError)
  })
})
