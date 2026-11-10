// Half-circle gauge (AppFolio "Rent Collected" / "% Occupied" style). Plain SVG: no chart lib
// needed for one arc. Follows the chart rules in docs/design-system.md: token colors, role="img"
// with a full aria-label, an sr-only table carrying the same numbers, no animation.

const R = 80
const STROKE = 22
const CX = 100
const CY = 95

function arc(fraction: number): string {
  const f = Math.min(Math.max(fraction, 0), 1)
  const angle = Math.PI * (1 - f) // 180° (left) → 0° (right)
  const x = CX + R * Math.cos(angle)
  const y = CY - R * Math.sin(angle)
  return `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`
}

export type GaugeTone = 'positive' | 'chart'

export function Gauge({
  title,
  caption,
  value,
  max,
  centerValue,
  centerLabel,
  minLabel,
  maxLabel,
  tone = 'chart',
  action,
}: {
  title: string
  /** One-line statement above the gauge, e.g. "83% of billed collected as of Nov 9, 2026". */
  caption: string
  value: number
  max: number
  centerValue: string
  centerLabel: string
  minLabel: string
  maxLabel: string
  tone?: GaugeTone
  action?: React.ReactNode
}) {
  const fraction = max > 0 ? value / max : 0
  const fillClass = tone === 'positive' ? 'stroke-status-active' : 'stroke-chart-1'
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-display text-base text-navy">{title}</h2>
        {action}
      </div>
      <div className="p-4">
        <p className="text-xs font-medium text-foreground">{caption}</p>
        <div role="img" aria-label={`${title}: ${caption}. ${centerValue} ${centerLabel}; scale ${minLabel} to ${maxLabel}.`}>
          <svg viewBox="0 0 200 125" className="mx-auto mt-2 h-40 w-full max-w-xs" aria-hidden="true">
            <path d={arc(1)} fill="none" className="stroke-muted" strokeWidth={STROKE} />
            {fraction > 0 && <path d={arc(fraction)} fill="none" className={fillClass} strokeWidth={STROKE} />}
            <text x={CX} y={CY - 18} textAnchor="middle" className="fill-navy font-display" fontSize="18">{centerValue}</text>
            <text x={CX} y={CY - 2} textAnchor="middle" className="fill-status-neutral" fontSize="8" letterSpacing="0.5">{centerLabel.toUpperCase()}</text>
            <text x={CX - R} y={CY + 24} textAnchor="middle" className="fill-foreground" fontSize="9">{minLabel}</text>
            <text x={CX + R} y={CY + 24} textAnchor="middle" className="fill-foreground" fontSize="9">{maxLabel}</text>
          </svg>
        </div>
        <table className="sr-only">
          <caption>{title}</caption>
          <tbody>
            <tr><th scope="row">{centerLabel}</th><td>{centerValue}</td></tr>
            <tr><th scope="row">Scale</th><td>{minLabel} to {maxLabel}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
