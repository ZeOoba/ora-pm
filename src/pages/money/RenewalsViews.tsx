import { useNavigate } from 'react-router'
import { cn } from '../../lib/utils'
import { formatDate } from '../../lib/format'
import { compactMoney } from '../today/today-queue'
import { RenewalStatusSelect } from '../renewals/RenewalStatusSelect'
import { RENEWAL_STATUS_OPTIONS } from '../renewals/renewal-status'
import type { BoardCard, BoardStage, Lane } from './money-derive'

const STAGE_TONE: Record<BoardStage, string> = {
  untracked: 'text-status-danger',
  tracking: 'text-gold-600',
  proposal_sent: 'text-status-pending',
  negotiating: 'text-status-pending',
  executed: 'text-status-active',
  declined: 'text-muted-foreground',
}

function stageLabel(l: Lane): { label: string; tone: string } {
  if (!l.renewal) return { label: 'Not tracked', tone: STAGE_TONE.untracked }
  const label = RENEWAL_STATUS_OPTIONS.find((o) => o.value === l.renewal?.status)?.label ?? l.renewal.status
  return { label, tone: STAGE_TONE[l.renewal.status] }
}

/** 18-month expiry timeline (prototype screen 3c): one lane per expiring lease. */
export function RenewalsTimeline({ lanes, months }: { lanes: Lane[]; months: { label: string; year: boolean }[] }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[240px_minmax(0,1fr)] border-t border-navy">
          <div />
          <div className="grid border-b border-border py-1.5 font-mono text-[10px] text-muted-foreground" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}>
            {months.map((m, i) => <span key={i} className={cn('text-center', m.year && 'text-navy')}>{m.label}</span>)}
          </div>
        </div>
        {lanes.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No active lease expires in the next {months.length} months.</p>}
        {lanes.map((l) => {
          const s = stageLabel(l)
          return (
            <div key={l.lease_id} role="link" tabIndex={0} onClick={() => navigate(`/leases/${l.lease_id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/leases/${l.lease_id}`) }}
              className="grid min-h-[50px] cursor-pointer grid-cols-[240px_minmax(0,1fr)] items-center border-b border-border/60 hover:bg-muted">
              <div className="flex min-w-0 flex-col pr-3">
                <span className="truncate text-sm font-semibold text-navy">{l.tenant}</span>
                <span className="truncate text-xs text-muted-foreground">{l.place}</span>
              </div>
              <div className="relative h-[50px]" aria-label={`${l.tenant}: expires ${formatDate(l.end_date)}, ${s.label}`}>
                <div className="absolute inset-y-0 left-0 w-px bg-status-danger" />
                {l.bandLeftPct != null && l.bandWidthPct != null && (
                  <div className="absolute top-3.5 h-[22px] border-l-2 border-gold bg-gold/35" style={{ left: `${l.bandLeftPct}%`, width: `${l.bandWidthPct}%` }} />
                )}
                <div className="absolute top-3.5 h-[22px] w-[3px] bg-navy" style={{ left: `${l.expiryPct}%` }} />
                <div className={cn('absolute top-4 whitespace-nowrap font-mono text-[11px]', l.expiryPct > 70 ? '-translate-x-full pr-2' : 'pl-2')}
                  style={{ left: `${l.expiryPct}%` }}>
                  {l.abr == null ? '—' : compactMoney(l.abr)} · <span className={s.tone}>{s.label}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <span className="pt-2.5 text-xs text-muted-foreground">
        Navy tick = lease expiry. Gold band = decision window (renewal's decision-by date to expiry). Red rule = this month. Holdovers sit at the left edge.
      </span>
    </div>
  )
}

/** Stage board: one column per renewal status, plus expiring leases with no renewal record yet. */
export function RenewalsBoard({ columns }: { columns: { key: BoardStage; label: string; cards: BoardCard[]; abr: number }[] }) {
  const navigate = useNavigate()
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
      {columns.map((c) => (
        <section key={c.key} aria-label={c.label} className="flex min-h-80 flex-col gap-2 rounded-xl bg-muted p-3">
          <div className="flex justify-between text-xs">
            <span className={cn('font-semibold uppercase tracking-[0.06em]', STAGE_TONE[c.key])}>{c.label} · {c.cards.length}</span>
            <span className="font-mono text-muted-foreground">{compactMoney(c.abr)}</span>
          </div>
          {c.cards.map((k) => (
            <div key={k.key} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
              <button type="button" onClick={() => navigate(`/leases/${k.lease_id}`)} className="flex flex-col gap-0.5 text-left">
                <span className="text-[13px] font-semibold text-navy">{k.tenant}</span>
                <span className="text-[11px] text-muted-foreground">{k.place} · expires {formatDate(k.expires)}{k.abr != null ? ` · ${compactMoney(k.abr)}/yr` : ''}</span>
              </button>
              {k.renewal && <RenewalStatusSelect id={k.renewal.id} status={k.renewal.status} tenantName={k.tenant} />}
            </div>
          ))}
          {c.key === 'untracked' && c.cards.length > 0 && (
            <p className="text-[11px] text-muted-foreground">These expiring leases have no renewal record. The app creates one automatically only for leases entered through its lease form, so these were likely imported.</p>
          )}
        </section>
      ))}
    </div>
  )
}
