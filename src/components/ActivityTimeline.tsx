import { formatDate } from '../lib/format'
import { sortTimeline, type TimelineItem } from './timeline'

export function ActivityTimeline({ items, emptyLabel = 'No activity yet.' }: { items: TimelineItem[]; emptyLabel?: string }) {
  const sorted = sortTimeline(items)
  if (sorted.length === 0) return <p className="text-sm text-status-neutral">{emptyLabel}</p>
  return (
    <ol className="relative space-y-4 border-l border-border pl-5">
      {sorted.map((it, i) => (
        <li key={`${it.date}-${i}`} className="relative">
          <span className="absolute -left-[25px] top-1.5 size-2 rounded-full bg-gold" aria-hidden="true" />
          <p className="text-xs font-medium text-status-neutral">{formatDate(it.date)}</p>
          <p className="text-sm font-medium text-navy">{it.label}</p>
          {it.detail && <p className="text-sm text-status-neutral">{it.detail}</p>}
        </li>
      ))}
    </ol>
  )
}
