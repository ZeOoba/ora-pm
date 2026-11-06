import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Portal pages style through theme tokens/classes only: no inline style objects, no hex color
// literals (e.g. bg-[#1B2A4A]) and no font-serif (the display font is the `font-display` token).
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
  })
}

describe('src/portal uses theme tokens, not inline color literals', () => {
  const root = join(__dirname, '../../src/portal')
  for (const file of walk(root)) {
    const name = file.split(/[\\/]src[\\/]/)[1].replace(/\\/g, '/')
    const source = readFileSync(file, 'utf-8')
    it(`${name} has no style={{ ... }}`, () => {
      expect(source).not.toContain('style={{')
    })
    it(`${name} has no hex color literals or font-serif`, () => {
      expect(source).not.toMatch(/#[0-9A-Fa-f]{6}\b/)
      expect(source).not.toContain('font-serif')
    })
  }
})
