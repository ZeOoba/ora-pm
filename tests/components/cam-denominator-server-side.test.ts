/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Audit finding cam-denominator-client-snapshot: CAMList.tsx summed the pro-rata denominator in the
// browser from TODAY's active rent-roll rows and POSTed it (and the recoverable total) to
// /cam/calculate, which trusted both. The server now recomputes both from the DB; the page must not
// send them, and takes the lease list + displayed pool from GET /cam/pool. Source scan, same
// approach as cam-recoverable-total-server-side.test.ts (no React-rendering harness in this repo).
describe('CAMList source: CAM pool comes from the server', () => {
  const source = readFileSync(join(__dirname, '../../src/pages/cam/CAMList.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

  it('does not send a denominator or recoverable total to /cam/calculate', () => {
    expect(source).not.toMatch(/total_leased_sf\s*:/)
    expect(source).not.toMatch(/total_property_recoverable_expenses\s*:/)
  })

  it('does not derive the pool from the client-side rent roll', () => {
    expect(source).not.toMatch(/\/reports\/rent-roll/)
    expect(source).not.toMatch(/reduce\(\s*\(s,\s*r\)\s*=>\s*s\s*\+\s*\(r\.sf/)
  })

  it('reads the server-computed pool from /cam/pool with property_id and year', () => {
    expect(source).toMatch(/\/cam\/pool\?property_id=\$\{[^}]+\}&year=\$\{[^}]+\}/)
  })
})
