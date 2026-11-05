import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Paged list endpoints default to 50 rows. A picker/selector that calls them with a bare
// api.get silently truncates at 50 -- use api.listAll (pages through everything). Detail
// routes (/tenants/${id}) are fine.
const PAGED = ['tenants', 'properties', 'leases', 'charges', 'payments', 'expenses']
const BARE = new RegExp(`api\\.get<[^(]*?>\\(\\s*[\`'"]/(?:${PAGED.join('|')})(?:[?'"\`]|$)`)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
  })
}

describe('no bare api.get to paged list endpoints in src/pages', () => {
  const files = walk(join(__dirname, '../../src/pages'))

  it('the matcher flags bare list calls and ignores detail routes', () => {
    expect(BARE.test("api.get<{ data: T[] }>('/tenants')")).toBe(true)
    expect(BARE.test("api.get<{ data: T[] }>('/leases?status=active')")).toBe(true)
    expect(BARE.test('api.get<{ data: T }>(`/tenants/${id}`)')).toBe(false)
  })

  for (const file of files) {
    it(file.split(/[\\/]src[\\/]/)[1], () => {
      expect(BARE.test(readFileSync(file, 'utf-8'))).toBe(false)
    })
  }
})
