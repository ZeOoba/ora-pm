import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8')

describe('theme tokens (src/index.css)', () => {
  it('parchment is the corrected brand value', () => {
    expect(css).toMatch(/--color-parchment:\s*#F5F3EF/i)
  })
  it('the wrong parchment value is gone', () => {
    expect(css.toUpperCase()).not.toContain('#F5F0E8')
  })
  const tokens = [
    'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
    'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted',
    'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'border', 'input',
    'ring', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
  ]
  for (const t of tokens) {
    it(`defines --color-${t}`, () => {
      expect(css).toMatch(new RegExp(`--color-${t}[ \\t]*:`))
    })
  }
  it('defines radius tokens', () => {
    for (const r of ['--radius', '--radius-sm', '--radius-md', '--radius-lg']) {
      expect(css).toMatch(new RegExp(`${r}[ \\t]*:`))
    }
  })
  it('chart colors use brand values', () => {
    expect(css).toMatch(/--color-chart-1:\s*#1B2A4A/i)
    expect(css).toMatch(/--color-chart-2:\s*#C9A96E/i)
    expect(css).toMatch(/--color-chart-3:\s*#4F6A93/i)
    expect(css).toMatch(/--color-chart-4:\s*#8FA3C2/i)
    expect(css).toMatch(/--color-chart-5:\s*#B8975A/i)
  })
  it('base layer applies border-border globally', () => {
    expect(css).toMatch(/@apply border-border/)
  })
})
