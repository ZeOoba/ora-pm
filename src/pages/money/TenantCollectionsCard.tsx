import { useState } from 'react'
import { toast } from 'sonner'
import { QueryState } from '../../components/QueryState'
import { formatCurrency, formatDate } from '../../lib/format'
import { cn } from '../../lib/utils'
import { useOpenCollectionsRecords, useResolveRecord, type DisputeRecord, type PromiseRecord } from './collections-records'
import { CollectionsRecordSheet, type RecordKind, type RecordTarget } from './CollectionsRecordSheet'

/**
 * Open promises to pay and disputes for one tenant (B1), with resolve actions and a way to log a
 * new one against any of the tenant's leases. Work-log only: nothing here changes a balance.
 */
export function TenantCollectionsCard({ tenantId, leases }: { tenantId: string; leases: { id: string; label: string }[] }) {
  const { promises, disputes } = useOpenCollectionsRecords(tenantId)
  const resolvePromise = useResolveRecord('promises')
  const resolveDispute = useResolveRecord('disputes')
  const [logFor, setLogFor] = useState<{ target: RecordTarget; kind: RecordKind } | null>(null)
  const [leaseId, setLeaseId] = useState(leases[0]?.id ?? '')
  const chosen = leases.find((l) => l.id === leaseId) ?? leases[0]
  const label = (leaseId: string) => leases.find((l) => l.id === leaseId)?.label ?? 'Lease'

  const onPromise = (p: PromiseRecord, status: 'kept' | 'broken' | 'cancelled') =>
    resolvePromise.mutate({ id: p.id, body: { status } }, {
      onSuccess: () => toast.success(`Promise marked ${status}`),
      onError: (e) => toast.error(`Couldn't update the promise: ${e.message}`),
    })
  const onDispute = (d: DisputeRecord, status: 'resolved' | 'withdrawn') =>
    resolveDispute.mutate({ id: d.id, body: { status } }, {
      onSuccess: () => toast.success(`Dispute marked ${status}`),
      onError: (e) => toast.error(`Couldn't update the dispute: ${e.message}`),
    })
  const busy = resolvePromise.isPending || resolveDispute.isPending

  return (
    <section aria-label="Collections" className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-xl text-navy">Collections</h2>
        {leases.length > 0 && (
          <div className="flex gap-1.5 text-xs">
            <button type="button" onClick={() => setLogFor({ target: { lease_id: chosen.id, label: chosen.label }, kind: 'promise' })}
              className="rounded-md border border-border px-2 py-1 hover:bg-muted">+ Promise</button>
            <button type="button" onClick={() => setLogFor({ target: { lease_id: chosen.id, label: chosen.label }, kind: 'dispute' })}
              className="rounded-md border border-border px-2 py-1 hover:bg-muted">+ Dispute</button>
          </div>
        )}
      </div>
      {leases.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Log against
          <select aria-label="Lease to log against" value={chosen?.id} onChange={(e) => setLeaseId(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-navy">
            {leases.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
      )}
      <QueryState query={[promises, disputes]}>
        {(promises.data ?? []).length === 0 && (disputes.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No open promises or disputes.</p>
        )}
        {(promises.data ?? []).map((p) => (
          <div key={p.id} className="flex flex-col gap-1 border-t border-border/60 pt-2 text-[13px]">
            <span className={cn('font-mono text-[11px]', p.lapsed ? 'text-status-danger' : 'text-status-active')}>
              {p.lapsed ? 'PROMISE LAPSED' : 'PROMISED'} · {label(p.lease_id)}
            </span>
            <span className="font-semibold text-navy">{formatCurrency(p.amount)} by {formatDate(p.promised_date)}</span>
            {p.notes && <span className="text-xs text-muted-foreground">{p.notes}</span>}
            <div className="flex gap-1.5 text-xs">
              {(['kept', 'broken', 'cancelled'] as const).map((st) => (
                <button key={st} type="button" disabled={busy} onClick={() => onPromise(p, st)}
                  className="rounded-md border border-border px-2 py-0.5 capitalize hover:bg-muted disabled:opacity-50">{st}</button>
              ))}
            </div>
          </div>
        ))}
        {(disputes.data ?? []).map((d) => (
          <div key={d.id} className="flex flex-col gap-1 border-t border-border/60 pt-2 text-[13px]">
            <span className="font-mono text-[11px] text-status-pending">DISPUTED · {label(d.lease_id)}</span>
            <span className="font-semibold text-navy">{d.amount != null ? `${formatCurrency(d.amount)}: ` : ''}{d.reason}</span>
            <span className="text-xs text-muted-foreground">Opened {formatDate(d.created_at)}{d.created_by ? ` by ${d.created_by}` : ''}</span>
            <div className="flex gap-1.5 text-xs">
              {(['resolved', 'withdrawn'] as const).map((st) => (
                <button key={st} type="button" disabled={busy} onClick={() => onDispute(d, st)}
                  className="rounded-md border border-border px-2 py-0.5 capitalize hover:bg-muted disabled:opacity-50">{st}</button>
              ))}
            </div>
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">A record for the collections queue. It does not change the balance or pause late fees.</p>
      </QueryState>
      <CollectionsRecordSheet key={logFor ? `${logFor.target.lease_id}-${logFor.kind}` : 'none'}
        target={logFor?.target ?? null} initialKind={logFor?.kind} onClose={() => setLogFor(null)} />
    </section>
  )
}
