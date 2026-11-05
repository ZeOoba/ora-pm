import { Pie, PieChart } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart'
import { formatSF } from '../../lib/format'
import type { OccupancySplit } from './derive'

const SERIES = [
  { key: 'occupied', label: 'Occupied', color: 'var(--color-chart-1)' },
  { key: 'vacant', label: 'Vacant', color: 'var(--color-chart-2)' },
] as const

export function OccupancyDonut({ split }: { split: OccupancySplit }) {
  const config: ChartConfig = Object.fromEntries(SERIES.map((s) => [s.key, { label: s.label, color: s.color }]))
  const values = { occupied: split.occupiedSf, vacant: split.vacantSf }
  const data = SERIES.map((s) => ({ name: s.key, value: values[s.key], fill: `var(--color-${s.key}, ${s.color})` }))
  const summary = `${split.occupiedPct}% occupied. Occupied ${formatSF(split.occupiedSf)}, vacant ${formatSF(split.vacantSf)}`

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-2 font-display text-base text-navy">SF occupancy</h2>
      <div role="img" aria-label={`SF occupancy donut chart. ${summary}`}>
        <div className="relative">
          <ChartContainer config={config} className="aspect-auto h-44 w-full" aria-hidden="true">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${formatSF(Number(v))}`} />} />
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="90%" stroke="none" isAnimationActive={false} />
            </PieChart>
          </ChartContainer>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="font-display text-2xl text-navy">{split.occupiedPct}%</span>
          </div>
        </div>
        <ul className="mt-2 flex justify-center gap-4 text-xs text-status-neutral" aria-hidden="true">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className={`inline-block size-2.5 rounded-sm ${s.key === 'occupied' ? 'bg-chart-1' : 'bg-chart-2'}`} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      <table className="sr-only">
        <caption>
          SF occupancy: occupied versus vacant square feet. Units with status notice count as occupied; unavailable units are excluded from both.
        </caption>
        <thead>
          <tr><th scope="col">Status</th><th scope="col">Square feet</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">Occupied</th><td>{formatSF(split.occupiedSf)}</td></tr>
          <tr><th scope="row">Vacant</th><td>{formatSF(split.vacantSf)}</td></tr>
          <tr><th scope="row">Total</th><td>{formatSF(split.totalSf)}</td></tr>
        </tbody>
      </table>
    </div>
  )
}
