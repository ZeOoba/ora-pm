import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { QueryState } from '../../components/QueryState'
import { formatDate } from '../../lib/format'
import { cn } from '../../lib/utils'
import type { LeaseStatement } from '../statements/statement-view'
import { ledgerWindow } from './ledger-window'

export interface LedgerLease {
  id: string
  label: string
}

function cents(c: number): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c / 100)
}

type Filter = 'All' | 'Charges' | 'Payments'

/**
 * Tenant ledger (prototype screen 2b): the per-lease statement from GET /statements/lease/:id,
 * newest first, with the server's running balance. Amounts are server cents; the client only
 * formats them.
 */
export function TenantLedger({ leases }: { leases: LedgerLease[] }) {
  const [leaseId, setLeaseId] = useState(leases[0]?.id)
  const [filter, setFilter] = useState<Filter>('All')
  const { start, end } = ledgerWindow()
  const stmt = useQuery({
    queryKey: ['statement', leaseId, start, end],
    queryFn: () => api.get<{ data: LeaseStatement }>(`/statements/lease/${leaseId}?start=${start}&end=${end}`).then((r) => r.data),
    enabled: !!leaseId,
  })

  if (!leaseId) return <p className="text-sm text-muted-foreground">No leases on file, so there is no ledger.</p>

  const s = stmt.data?.statement
  const lines = (s?.lines ?? [])
    .filter((l) => filter === 'All' || (filter === 'Charges' ? l.kind === 'charge' : l.kind === 'payment'))
    .slice()
    .reverse()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2.5">
        <h2 className="font-display text-2xl text-navy">Ledger</h2>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {leases.length > 1 && leases.map((l) => (
            <Pill key={l.id} on={l.id === leaseId} onClick={() => setLeaseId(l.id)}>{l.label}</Pill>
          ))}
          {(['All', 'Charges', 'Payments'] as Filter[]).map((f) => (
            <Pill key={f} on={f === filter} onClick={() => setFilter(f)}>{f}</Pill>
          ))}
        </div>
      </div>
      <QueryState query={stmt}>
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <div className="grid min-w-[480px] grid-cols-[80px_minmax(0,1fr)_96px_96px_100px] gap-2.5 bg-muted px-4 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            <span>Date</span><span>Item</span><span className="text-right">Charge</span><span className="text-right">Paid</span><span className="text-right">Balance</span>
          </div>
          {lines.map((l) => (
            <div key={`${l.kind}-${l.id}`} className="grid min-w-[480px] grid-cols-[80px_minmax(0,1fr)_96px_96px_100px] items-center gap-2.5 border-t border-border/60 px-4 py-2.5 text-[13px]">
              <span className="font-mono text-xs text-muted-foreground">{formatDate(l.date).replace(/, \d{4}$/, '')}</span>
              <span className="truncate">{l.label}</span>
              <span className="text-right font-mono">{l.kind === 'charge' ? cents(l.amountCents) : ''}</span>
              <span className="text-right font-mono text-status-active">{l.kind === 'payment' ? cents(Math.abs(l.amountCents)) : ''}</span>
              <span className="text-right font-mono font-semibold">{cents(l.balanceCents)}</span>
            </div>
          ))}
          {s && (
            <div className="grid min-w-[480px] grid-cols-[80px_minmax(0,1fr)_96px_96px_100px] gap-2.5 border-t border-border/60 bg-muted/50 px-4 py-2.5 text-[13px] text-muted-foreground">
              <span className="font-mono text-xs">{formatDate(s.start).replace(/, \d{4}$/, '')}</span>
              <span>Opening balance</span><span /><span />
              <span className="text-right font-mono">{cents(s.openingCents)}</span>
            </div>
          )}
        </div>
        {s && s.pendingCents > 0 && (
          <p className="text-xs text-status-warning">{cents(s.pendingCents)} in ACH payments is still pending and not counted above.</p>
        )}
        <Link to={`/statements/lease/${leaseId}`} className="text-xs text-muted-foreground hover:text-navy">Full statement →</Link>
      </QueryState>
    </div>
  )
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cn('rounded-full border px-2.5 py-1', on ? 'border-navy bg-navy text-white' : 'border-border bg-card text-navy hover:bg-muted')}>
      {children}
    </button>
  )
}
