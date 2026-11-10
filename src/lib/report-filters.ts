import { useSearchParams } from 'react-router'
import { isPreset, resolvePreset, type DatePreset, type ResolvedRange } from './date-range'

const ISO = /^\d{4}-\d{2}-\d{2}$/

export type ReportFilterState = {
  /** '' = all current properties */
  propertyId: string
  preset: DatePreset | 'custom'
  range: ResolvedRange
}

/** Parse ?property=&range=&from=&to= (defaults: all properties, month-to-date). */
export function parseReportFilters(sp: URLSearchParams, today: Date = new Date()): ReportFilterState {
  const propertyId = sp.get('property') ?? ''
  const raw = sp.get('range')
  if (raw === 'custom') {
    const from = sp.get('from') ?? ''
    const to = sp.get('to') ?? ''
    if (ISO.test(from) && ISO.test(to) && from <= to) {
      return { propertyId, preset: 'custom', range: { from, to, label: `${from} – ${to}` } }
    }
  }
  const preset: DatePreset = isPreset(raw) ? raw : 'mtd'
  return { propertyId, preset, range: resolvePreset(preset, today) }
}

/** Query string for the report endpoints from the current filters. */
export function reportQuery(f: Pick<ReportFilterState, 'propertyId' | 'range'>): string {
  const sp = new URLSearchParams({ from: f.range.from, to: f.range.to })
  if (f.propertyId) sp.set('property_ids', f.propertyId)
  return sp.toString()
}

export function useReportFilters() {
  const [sp, setSp] = useSearchParams()
  const state = parseReportFilters(sp)
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setSp(next, { replace: true })
  }
  return {
    ...state,
    /** The current filter params, for links that carry the filters to another page. */
    search: sp.toString(),
    setProperty: (id: string) => update({ property: id }),
    setPreset: (p: DatePreset | 'custom') =>
      p === 'custom'
        ? update({ range: 'custom', from: state.range.from, to: state.range.to })
        : update({ range: p, from: null, to: null }),
    setCustom: (from: string, to: string) => update({ range: 'custom', from, to }),
  }
}
