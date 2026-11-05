import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDate } from '../../lib/format'
import type { CriticalDateRow } from '../../types'

const URGENCY_BG: Record<string, string> = {
  overdue: 'border-red-300 bg-red-50',
  urgent:  'border-orange-300 bg-orange-50',
  warning: 'border-yellow-300 bg-yellow-50',
  notice:  'border-border bg-white',
}

export function CriticalDatesFeed() {
  const { data, isLoading } = useQuery({
    queryKey: ['critical-dates'],
    queryFn: () => api.get<{ data: CriticalDateRow[] }>('/reports/critical-dates').then(r => r.data),
  })

  if (isLoading) return <p className="text-muted-foreground p-4">Loading…</p>

  return (
    <div>
      <PageHeader title="Critical Dates" />
      <div className="space-y-2">
        {data?.length === 0 && (
          <p className="text-muted-foreground text-center py-8">No critical dates in the next 90 days.</p>
        )}
        {data?.map(item => (
          <div
            key={`${item.date_type}-${item.reference_id}`}
            className={`flex items-center justify-between p-4 rounded-lg border ${URGENCY_BG[item.urgency] ?? URGENCY_BG.notice}`}
          >
            <div>
              <p className="font-medium text-foreground">{item.tenant_name}</p>
              <p className="text-sm text-muted-foreground">
                {item.property_name}{item.suite ? ` · ${item.suite}` : ''} · {item.date_type.replace(/_/g, ' ')}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-foreground">{formatDate(item.critical_date)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {item.days_until < 0
                  ? `${Math.abs(item.days_until)} days overdue`
                  : item.days_until === 0
                  ? 'Today'
                  : `${item.days_until} days`}
              </p>
              <div className="mt-1"><StatusBadge status={item.urgency} /></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
