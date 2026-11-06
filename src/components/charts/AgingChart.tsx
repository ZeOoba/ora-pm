import { Bar, BarChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart'
import { formatCurrency } from '../../lib/format'
import { AGING_COLUMNS, UNALLOCATED_COLUMN, agingChartRows, hasUnallocated, type AgingTotals } from '../../pages/ar/ar-aging-view'

// Stacked portfolio AR aging bar. Shared by the AR page and Home; renders the server-computed
// `totals` from GET /api/reports/ar-aging as-is (never re-derives buckets).
export function AgingChart({ totals, className = 'mb-6' }: { totals: AgingTotals; className?: string }) {
  const series = hasUnallocated(totals) ? [...AGING_COLUMNS, UNALLOCATED_COLUMN] : AGING_COLUMNS
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))
  const summary = series.map((s) => `${s.label} ${formatCurrency(totals[s.key])}`).join(', ')

  return (
    <div className={`${className} rounded-lg border border-border bg-card p-4`}>
      <h2 className="mb-2 font-display text-base text-navy">Portfolio aging</h2>
      {/* The SVG is decorative for assistive tech; the same numbers are in the visually hidden table. */}
      <div role="img" aria-label={`Portfolio AR aging, total ${formatCurrency(totals.balance)}: ${summary}`}>
        <ChartContainer config={config} className="aspect-auto h-28 w-full" aria-hidden="true">
          <BarChart data={agingChartRows(totals)} layout="vertical" margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" hide />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${formatCurrency(Number(v))}`} />} />
            <ChartLegend content={<ChartLegendContent />} />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} stackId="aging" fill={`var(--color-${s.key}, ${s.color})`} isAnimationActive={false} />
            ))}
          </BarChart>
        </ChartContainer>
      </div>
      <table className="sr-only">
        <caption>Portfolio AR aging by bucket</caption>
        <thead>
          <tr><th scope="col">Bucket</th><th scope="col">Amount</th></tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.key}><th scope="row">{s.label}</th><td>{formatCurrency(totals[s.key])}</td></tr>
          ))}
          <tr><th scope="row">Total</th><td>{formatCurrency(totals.balance)}</td></tr>
        </tbody>
      </table>
    </div>
  )
}
