import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import type { Property } from '../../types'

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

export function QBExport() {
  const now = new Date()
  const { data: properties } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.listAll<Property>('/properties'),
  })

  const [propertyId, setPropertyId] = useState('')
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleExport = async () => {
    if (!propertyId) return
    setLoading(true)
    setError(null)
    try {
      const { blob, filename } = await api.download(
        `/exports/qb-iif?property_id=${propertyId}&year=${year}&month=${month}`,
        'export.iif'
      )
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <PageHeader title="QB Desktop Export" />
      <div className="bg-white rounded-lg border border-border p-6 max-w-md space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Property</label>
          <select
            value={propertyId}
            onChange={e => setPropertyId(e.target.value)}
            className="w-full border border-border rounded-md px-3 py-2 text-sm"
          >
            <option value="">Select property…</option>
            {properties?.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Year</label>
            <input
              type="number"
              value={year}
              onChange={e => setYear(parseInt(e.target.value))}
              min={2020}
              max={2050}
              className="w-full border border-border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Month</label>
            <select
              value={month}
              onChange={e => setMonth(parseInt(e.target.value))}
              className="w-full border border-border rounded-md px-3 py-2 text-sm"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <p className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded p-2">{error}</p>
        )}

        <button
          onClick={handleExport}
          disabled={!propertyId || loading}
          className="w-full bg-primary hover:bg-primary/90 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {loading ? 'Generating…' : 'Download IIF File'}
        </button>

        <p className="text-xs text-muted-foreground">
          QB Desktop: File → Utilities → Import → IIF Files
        </p>
      </div>
    </div>
  )
}
