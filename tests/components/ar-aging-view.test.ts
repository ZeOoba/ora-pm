import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { agingChartRows, AGING_COLUMNS, UNALLOCATED_COLUMN, hasUnallocated, type AgingTotals } from '../../src/pages/ar/ar-aging-view'

const totals: AgingTotals = { balance: 1500, current: 100, d1_30: 200, d31_60: 300, d61_90: 400, d90_plus: 500, unallocated: 0 }

describe('AR aging view helpers', () => {
  it('bucket columns are the five age buckets in order', () => {
    expect(AGING_COLUMNS.map(c => c.key)).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'])
    expect(AGING_COLUMNS.map(c => c.label)).toEqual(['Current', '1–30', '31–60', '61–90', '90+'])
  })
  it('chart rows: one stacked row of portfolio totals; unallocated only when non-zero', () => {
    expect(agingChartRows(totals)).toEqual([{ name: 'Portfolio', current: 100, d1_30: 200, d31_60: 300, d61_90: 400, d90_plus: 500 }])
    expect(agingChartRows({ ...totals, unallocated: 25, balance: 1525 })[0]).toMatchObject({ unallocated: 25 })
  })
  it('hasUnallocated', () => {
    expect(hasUnallocated(totals)).toBe(false)
    expect(hasUnallocated({ ...totals, unallocated: 0.01 })).toBe(true)
    expect(hasUnallocated(undefined)).toBe(false)
  })
})

describe('AR aging chart colors come from theme tokens', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const css = read('../../src/index.css')

  it('ar-aging-view.ts has no hex color literals', () => {
    expect(read('../../src/pages/ar/ar-aging-view.ts')).not.toMatch(/#[0-9A-Fa-f]{6}/)
  })
  it('every series color is a var(--color-*) token that exists in the @theme', () => {
    for (const c of [...AGING_COLUMNS, UNALLOCATED_COLUMN]) {
      const m = /^var\((--color-[a-z0-9-]+)\)$/.exec(c.color)
      expect(m, `${c.key}: ${c.color}`).not.toBeNull()
      expect(css).toContain(`${m![1]}:`)
    }
  })
  it('bucket color mapping is pinned', () => {
    expect(Object.fromEntries([...AGING_COLUMNS, UNALLOCATED_COLUMN].map(c => [c.key, c.color]))).toEqual({
      current: 'var(--color-chart-4)', d1_30: 'var(--color-chart-3)', d31_60: 'var(--color-chart-2)',
      d61_90: 'var(--color-status-warning)', d90_plus: 'var(--color-status-danger)', unallocated: 'var(--color-status-neutral)',
    })
  })
  it('<Bar fill> uses the ChartConfig-generated var, not the raw color', () => {
    const dash = read('../../src/pages/ar/ARDashboard.tsx')
    expect(dash).toContain('fill={`var(--color-${s.key})`}')
    expect(dash).not.toContain('fill={s.color}')
  })
})
