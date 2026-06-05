import { Card } from './Card'

export function KpiStat({
  label,
  value,
  sub,
  warn = false,
}: {
  label: string
  value: string | number
  sub?: string
  warn?: boolean
}) {
  return (
    <Card className={`p-4 ${warn ? 'border-status-danger/30 bg-status-danger/5' : ''}`}>
      <p className="text-xs uppercase tracking-wider text-status-neutral font-medium">{label}</p>
      <p className={`mt-1 text-2xl font-display ${warn ? 'text-status-danger' : 'text-navy'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-status-neutral/70">{sub}</p>}
    </Card>
  )
}
