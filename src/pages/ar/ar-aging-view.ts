// View helpers for the AR aging buckets returned by GET /api/reports/ar-aging (server-computed,
// oldest-first allocation — see server/lib/ar-aging.ts). The client only displays them; it never
// re-derives bucket amounts.

export type AgingBucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'

export interface AgingBuckets {
  current: number
  d1_30: number
  d31_60: number
  d61_90: number
  d90_plus: number
  unallocated: number
}

export type AgingTotals = AgingBuckets & { balance: number }

// Brand palette, light → dark by age (chart tokens from src/index.css + status danger for 90+).
export const AGING_COLUMNS: { key: AgingBucketKey; label: string; color: string }[] = [
  { key: 'current', label: 'Current', color: '#8FA3C2' },
  { key: 'd1_30', label: '1–30', color: '#4F6A93' },
  { key: 'd31_60', label: '31–60', color: '#C9A96E' },
  { key: 'd61_90', label: '61–90', color: '#B45309' },
  { key: 'd90_plus', label: '90+', color: '#B91C1C' },
]

export const UNALLOCATED_COLUMN = { key: 'unallocated' as const, label: 'Unallocated', color: '#475569' }

export function hasUnallocated(t: Pick<AgingBuckets, 'unallocated'> | undefined): boolean {
  return !!t && t.unallocated !== 0
}

// One stacked row of portfolio totals; the unallocated segment only appears when it is non-zero.
export function agingChartRows(t: AgingTotals): Record<string, number | string>[] {
  const row: Record<string, number | string> = { name: 'Portfolio' }
  for (const c of AGING_COLUMNS) row[c.key] = t[c.key]
  if (hasUnallocated(t)) row.unallocated = t.unallocated
  return [row]
}
