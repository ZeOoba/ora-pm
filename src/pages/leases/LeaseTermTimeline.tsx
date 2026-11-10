import { formatDate } from '../../lib/format'
import { termGeometry } from './lease-term'
import type { LeaseOption } from '../../types'

/** Lease term bar (prototype screen 2c): elapsed term, today, and each option's notice deadline. */
export function LeaseTermTimeline({ start, end, options, today = new Date().toISOString().slice(0, 10) }: {
  start: string
  end: string
  options: LeaseOption[] | null
  today?: string
}) {
  const g = termGeometry(start, end, today, options)
  const ended = today > end
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>Term timeline</span>
        <span>{ended ? `Term ended ${formatDate(end)}` : `${g.monthsRemaining} ${g.monthsRemaining === 1 ? 'month' : 'months'} remaining`}</span>
      </div>
      <div className="relative h-14" role="img"
        aria-label={`Lease term ${formatDate(start)} to ${formatDate(end)}; ${Math.round(g.elapsedPct)}% elapsed${g.deadlines.map((d) => `; ${d.label} by ${formatDate(d.date)}`).join('')}`}>
        <div className="absolute inset-x-0 top-[18px] h-2.5 bg-border" />
        <div className="absolute left-0 top-[18px] h-2.5 bg-navy" style={{ width: `${g.elapsedPct}%` }} />
        {g.deadlines.map((d) => (
          <div key={d.date + d.label} className={d.passed ? 'absolute top-[14px] h-[18px] w-1 bg-chart-4' : 'absolute top-[14px] h-[18px] w-1 bg-gold'} style={{ left: `${d.pct}%` }} />
        ))}
        {!ended && <div className="absolute top-2 h-[30px] w-0.5 bg-status-danger" style={{ left: `${g.todayPct}%` }} />}
        <span className="absolute left-0 top-9 font-mono text-[11px] text-muted-foreground">{formatDate(start)}</span>
        <span className="absolute right-0 top-9 font-mono text-[11px] text-muted-foreground">{formatDate(end)}</span>
      </div>
      {g.deadlines.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {g.deadlines.map((d) => (
            <span key={d.date + d.label} className={d.passed ? 'capitalize text-muted-foreground' : 'capitalize text-gold-600'}>
              {d.label}: {formatDate(d.date)}{d.passed ? ' (passed)' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
