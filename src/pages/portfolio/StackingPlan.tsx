import { useNavigate } from 'react-router'
import { cn } from '../../lib/utils'
import type { StackSuite, SuiteState } from './portfolio-derive'

const STATE_CLASS: Record<SuiteState, string> = {
  leased: 'border border-navy bg-navy text-white',
  expiring: 'border border-gold bg-gold text-navy',
  delinquent: 'border border-status-danger bg-status-danger text-white',
  vacant: 'border border-dashed border-chart-4 bg-[repeating-linear-gradient(135deg,var(--color-ivory)_0_6px,var(--color-muted)_6px_12px)] text-muted-foreground',
  unavailable: 'border border-border bg-muted text-muted-foreground',
}

const STACK_LEGEND: { state: SuiteState; label: string; swatch: string }[] = [
  { state: 'leased', label: 'Leased', swatch: 'bg-navy' },
  { state: 'expiring', label: 'Expires <12 mo', swatch: 'bg-gold' },
  { state: 'delinquent', label: 'Past due', swatch: 'bg-status-danger' },
  { state: 'vacant', label: 'Vacant', swatch: 'border border-dashed border-muted-foreground' },
]

/**
 * Suites as blocks sized by square footage and colored by status (prototype screen 2a). Blocks
 * wrap on narrow screens; each leased suite opens its tenant.
 */
export function StackingPlan({ suites }: { suites: StackSuite[] }) {
  const navigate = useNavigate()
  const summary = suites.map((s) => `Suite ${s.suite}, ${s.sf.toLocaleString('en-US')} SF, ${s.state}${s.tenant_id ? `, ${s.tenant}` : ''}`).join('; ')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
        {STACK_LEGEND.map((l) => (
          <span key={l.state} className="flex items-center gap-1.5"><span className={cn('size-2.5', l.swatch)} />{l.label}</span>
        ))}
      </div>
      <div role="list" aria-label={`Stacking plan: ${summary}`} className="flex flex-wrap gap-[3px]">
        {suites.map((s) => {
          const go = s.tenant_id ? () => navigate(`/tenants/${s.tenant_id}`) : undefined
          return (
            <div key={s.unit_id} role="listitem" onClick={go}
              onKeyDown={go ? (e) => { if (e.key === 'Enter') go() } : undefined}
              tabIndex={go ? 0 : undefined}
              style={{ flexGrow: Math.max(1, s.sf), flexBasis: 120 }}
              className={cn('flex h-28 min-w-0 flex-col justify-between overflow-hidden p-2.5', STATE_CLASS[s.state], go && 'cursor-pointer hover:opacity-90')}>
              <div className="flex justify-between gap-1.5 font-mono text-[11px]">
                <span>{s.suite}</span><span className="whitespace-nowrap opacity-80">{s.sf.toLocaleString('en-US')} SF</span>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-semibold">{s.tenant}</span>
                <span className="truncate text-[11px] opacity-85">{s.detail}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
