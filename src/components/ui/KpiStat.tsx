import { Card } from './Card'

export type KpiAccent = 'positive' | 'negative' | 'navy' | 'warning'

// AppFolio-style colored left rule; token colors only (palette lint).
const ACCENT_BORDER: Record<KpiAccent, string> = {
  positive: 'border-l-4 border-l-status-active',
  negative: 'border-l-4 border-l-status-danger',
  navy: 'border-l-4 border-l-navy',
  warning: 'border-l-4 border-l-status-warning',
}
const ACCENT_TEXT: Record<KpiAccent, string> = {
  positive: 'text-status-active',
  negative: 'text-status-danger',
  navy: 'text-navy',
  warning: 'text-status-warning',
}

export function KpiStat({
  label,
  value,
  sub,
  warn = false,
  accent,
}: {
  label: string
  value: string | number
  sub?: string
  warn?: boolean
  /** Colored left rule + value color (dashboard money tiles). Ignored when `warn` is set. */
  accent?: KpiAccent
}) {
  if (accent && !warn) {
    return (
      <Card className={`p-4 ${ACCENT_BORDER[accent]}`}>
        <p className={`text-2xl font-display ${ACCENT_TEXT[accent]}`}>{value}</p>
        <p className="mt-1 text-sm text-foreground">{label}</p>
        {sub && <p className="mt-0.5 text-xs text-status-neutral/70">{sub}</p>}
      </Card>
    )
  }
  return (
    <Card className={`p-4 ${warn ? 'border-status-danger/30 bg-status-danger/5' : ''}`}>
      <p className="text-xs uppercase tracking-wider text-status-neutral font-medium">{label}</p>
      <p className={`mt-1 text-2xl font-display ${warn ? 'text-status-danger' : 'text-navy'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-status-neutral/70">{sub}</p>}
    </Card>
  )
}
