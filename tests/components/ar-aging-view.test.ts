import { describe, it, expect } from 'vitest'
import { agingChartRows, AGING_COLUMNS, hasUnallocated, type AgingTotals } from '../../src/pages/ar/ar-aging-view'

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
