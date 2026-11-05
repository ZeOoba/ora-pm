import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart'
import { formatSF } from '../../lib/format'
import type { ExpiryBucket } from './derive'

const config: ChartConfig = { sf: { label: 'SF expiring', color: 'var(--color-chart-1)' } }

export function ExpiryLadderChart({ ladder }: { ladder: ExpiryBucket[] }) {
  const totalSf = ladder.reduce((s, b) => s + b.sf, 0)
  const totalLeases = ladder.reduce((s, b) => s + b.leases, 0)
  const summary = ladder.map((b) => `${b.year} ${formatSF(b.sf)}`).join(', ')

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-2 font-display text-base text-navy">Lease expiry ladder</h2>
      <div role="img" aria-label={`Lease expiry ladder, square feet expiring by year: ${summary}`}>
        <ChartContainer config={config} className="aspect-auto h-44 w-full" aria-hidden="true">
          <BarChart data={ladder} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="year" tickLine={false} axisLine={false} />
            <YAxis hide />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={(v, _n, item) => `${item.payload?.year}: ${formatSF(Number(v))}`} />} />
            <Bar dataKey="sf" fill="var(--color-sf, var(--color-chart-1))" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartContainer>
      </div>
      <table className="sr-only">
        <caption>Square feet of leases expiring per calendar year, SF-weighted; leases without an end date are excluded.</caption>
        <thead>
          <tr><th scope="col">Year</th><th scope="col">Square feet</th><th scope="col">Leases</th></tr>
        </thead>
        <tbody>
          {ladder.map((b) => (
            <tr key={b.year}><th scope="row">{b.year}</th><td>{formatSF(b.sf)}</td><td>{b.leases}</td></tr>
          ))}
          <tr><th scope="row">Total</th><td>{formatSF(totalSf)}</td><td>{totalLeases}</td></tr>
        </tbody>
      </table>
    </div>
  )
}
