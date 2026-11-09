import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { DATE_PRESETS } from '../lib/date-range'
import type { useReportFilters } from '../lib/report-filters'
import { DateInput, Select } from './form/inputs'
import type { Property } from '../types'

/**
 * AppFolio-style filter bar: Property ("All current properties" or one) + Date preset.
 * State lives in the URL (?property=&range=&from=&to=) so filtered views are linkable.
 */
export function ReportFilters({ filters }: { filters: ReturnType<typeof useReportFilters> }) {
  const properties = useQuery({
    queryKey: ['properties', 'all-for-filter'],
    queryFn: () => api.listAll<Property>('/properties', { sort: 'name', dir: 'asc' }),
  })

  return (
    <div className="mb-6 flex flex-wrap items-end gap-4">
      <label className="flex w-full flex-col gap-1 sm:w-64">
        <span className="text-xs text-muted-foreground">Property</span>
        <Select
          value={filters.propertyId}
          onChange={(e) => filters.setProperty(e.target.value)}
          disabled={properties.isPending}
          aria-label="Property"
        >
          <option value="">All current properties</option>
          {(properties.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
        {properties.isError && <span className="text-xs text-status-danger">Couldn't load properties</span>}
      </label>
      <label className="flex w-full flex-col gap-1 sm:w-64">
        <span className="text-xs text-muted-foreground">Date</span>
        <Select
          value={filters.preset}
          onChange={(e) => filters.setPreset(e.target.value as typeof filters.preset)}
          aria-label="Date range"
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key === filters.preset ? filters.range.label : p.label}
            </option>
          ))}
          <option value="custom">Custom range…</option>
        </Select>
      </label>
      {filters.preset === 'custom' && (
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">From</span>
            <DateInput value={filters.range.from} max={filters.range.to}
              onChange={(e) => e.target.value && filters.setCustom(e.target.value, filters.range.to)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">To</span>
            <DateInput value={filters.range.to} min={filters.range.from}
              onChange={(e) => e.target.value && filters.setCustom(filters.range.from, e.target.value)} />
          </label>
        </div>
      )}
    </div>
  )
}
