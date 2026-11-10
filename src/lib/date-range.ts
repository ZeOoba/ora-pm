// Report date presets (AppFolio-style "Month-to-date (Nov 2026)" picker). Computed from the
// user's LOCAL calendar day, then sent to the API as YYYY-MM-DD.

export const DATE_PRESETS = [
  { key: 'mtd', label: 'Month-to-date' },
  { key: 'last_month', label: 'Last month' },
  { key: 'qtd', label: 'Quarter-to-date' },
  { key: 'ytd', label: 'Year-to-date' },
  { key: 't12', label: 'Trailing 12 months' },
  { key: 'last_year', label: 'Last year' },
] as const

export type DatePreset = (typeof DATE_PRESETS)[number]['key']
export type ResolvedRange = { from: string; to: string; label: string }

const PRESET_KEYS = new Set<string>(DATE_PRESETS.map((p) => p.key))
export function isPreset(v: unknown): v is DatePreset {
  return typeof v === 'string' && PRESET_KEYS.has(v)
}

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const monthName = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

export function resolvePreset(preset: DatePreset, today: Date = new Date()): ResolvedRange {
  const y = today.getFullYear()
  const m = today.getMonth()
  const to = toIsoDate(today)
  const label = DATE_PRESETS.find((p) => p.key === preset)!.label
  switch (preset) {
    case 'mtd':
      return { from: toIsoDate(new Date(y, m, 1)), to, label: `${label} (${monthName(today)})` }
    case 'last_month': {
      const start = new Date(y, m - 1, 1)
      return { from: toIsoDate(start), to: toIsoDate(new Date(y, m, 0)), label: `${label} (${monthName(start)})` }
    }
    case 'qtd':
      return { from: toIsoDate(new Date(y, m - (m % 3), 1)), to, label: `${label} (Q${Math.floor(m / 3) + 1} ${y})` }
    case 'ytd':
      return { from: `${y}-01-01`, to, label: `${label} (${y})` }
    case 't12':
      return { from: toIsoDate(new Date(y, m - 11, 1)), to, label }
    case 'last_year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `${label} (${y - 1})` }
  }
}
