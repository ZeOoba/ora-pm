// Books › Balance forward (migration 0030). Per LLC: bring each lease's balance over from
// QuickBooks as one opening-balance adjustment, from the A/R Aging Summary CSV (and figures typed
// by hand), with a preview first. Applied adjustments are listed below and can be voided to redo.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { FileDropZone } from '../../components/ui/FileDropZone'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { decodeIif } from './iif-file'
import { centralToday, signedDollars } from './ar-posting-helpers'
import {
  BF_FILE_MAX_BYTES, SOURCE_LABELS, STATUS_LABELS, agingFileProblem, parseDollarsInput,
  type BalanceForwardRecord, type BfPlan,
} from './balance-forward-helpers'

type ApiError = Error & { body?: { error?: unknown; data?: BfPlan } }

export function BalanceForward() {
  const qc = useQueryClient()
  const llcs = useQuery({ queryKey: ['balance-forwards', 'llcs'], queryFn: () => api.get<{ data: { name: string; properties: number }[] }>('/balance-forwards/llcs') })
  const [llc, setLlc] = useState('')
  const [asOf, setAsOf] = useState(() => centralToday())
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [assign, setAssign] = useState<Record<string, string>>({})
  const [manualText, setManualText] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<BfPlan | null>(null)
  const [armed, setArmed] = useState(false)
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null)

  const existing = useQuery({
    queryKey: ['balance-forwards', 'list', llc],
    queryFn: () => api.get<{ data: BalanceForwardRecord[] }>(`/balance-forwards?llc=${encodeURIComponent(llc)}`),
    enabled: !!llc,
  })

  const reset = () => { setPlan(null); setArmed(false) }
  const manual: Record<string, number> = {}
  const badManual: string[] = []
  for (const [leaseId, text] of Object.entries(manualText)) {
    if (text.trim() === '') continue
    const cents = parseDollarsInput(text)
    if (cents === null) badManual.push(leaseId)
    else manual[leaseId] = cents
  }

  const run = useMutation({
    mutationFn: (apply: boolean) => api.post<{ data: BfPlan }>('/balance-forwards/plan', {
      llc, as_of: asOf, csv: file?.text ?? null, file_name: file?.name ?? null, assign, manual,
      ...(apply ? { apply: true, expected_plan_hash: plan?.plan_hash } : {}),
    }),
    onSuccess: (res, apply) => {
      setPlan(res.data)
      setArmed(false)
      if (apply) {
        toast.success(`${res.data.written.length} balance forward${res.data.written.length === 1 ? '' : 's'} applied as of ${res.data.as_of}`)
        void qc.invalidateQueries({ queryKey: ['balance-forwards', 'list', llc] })
      }
    },
    onError: (e: ApiError) => {
      if (e.body?.data && 'rows' in e.body.data) setPlan(e.body.data)
      setArmed(false)
      toast.error(typeof e.body?.error === 'string' ? e.body.error : e.message)
    },
  })

  const voidIt = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.post(`/balance-forwards/${v.id}/void`, { reason: v.reason }),
    onSuccess: () => {
      toast.success('Balance forward voided; preview and apply again to replace it')
      setVoiding(null)
      reset()
      void qc.invalidateQueries({ queryKey: ['balance-forwards', 'list', llc] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const onFile = async (f: File) => {
    const problem = agingFileProblem(f)
    if (problem) { toast.error(problem); return }
    setFile({ name: f.name, text: decodeIif(await f.arrayBuffer()) })
    setAssign({})
    reset()
  }

  const leaseOptions = plan?.rows ?? []
  const canApply = !!plan && !plan.applied && plan.errors.length === 0 && plan.adjust_count > 0 && badManual.length === 0 && !run.isPending
  const live = (existing.data?.data ?? []).filter((r) => !r.voided_at)
  const voided = (existing.data?.data ?? []).filter((r) => r.voided_at)

  return (
    <div className="space-y-6">
      <PageHeader title="Balance forward" />

      <Card className="space-y-3 p-6">
        <p className="text-sm text-muted-foreground">
          Brings each lease's balance over from QuickBooks as one line, "Balance forward from prior system": the QuickBooks balance on the
          cut-off date minus what the app shows for that date. Charges and payments are not changed. Once applied, the lease's charges and
          payments dated on or before the cut-off are locked (void the balance forward to correct them).
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground" htmlFor="bf-llc">LLC</label>
            <select id="bf-llc" value={llc} onChange={(e) => { setLlc(e.target.value); setFile(null); setAssign({}); setManualText({}); reset() }}
              className="w-full max-w-md rounded-md border border-border px-3 py-2 text-sm">
              <option value="">Select an LLC…</option>
              {llcs.data?.data.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.properties} {l.properties === 1 ? 'property' : 'properties'})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground" htmlFor="bf-asof">QuickBooks balance as of</label>
            <input id="bf-asof" type="date" value={asOf} max={centralToday()} onChange={(e) => { setAsOf(e.target.value); reset() }}
              className="rounded-md border border-border px-3 py-2 text-sm" />
          </div>
        </div>
      </Card>

      {llc && live.length > 0 && (
        <Card className="space-y-3 p-6">
          <h2 className="text-base font-semibold text-foreground">Applied balance forwards</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead><TableHead>As of</TableHead><TableHead className="text-right">QuickBooks</TableHead>
                <TableHead className="text-right">App then</TableHead><TableHead className="text-right">Balance forward</TableHead><TableHead>By</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {live.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.tenant_name}{r.suite ? `, suite ${r.suite}` : ''}<div className="text-xs text-muted-foreground">{r.property_name}</div></TableCell>
                  <TableCell>{r.as_of}</TableCell>
                  <TableCell className="text-right font-mono">{signedDollars(Math.round(Number(r.qb_balance) * 100))}</TableCell>
                  <TableCell className="text-right font-mono">{signedDollars(Math.round(Number(r.app_balance) * 100))}</TableCell>
                  <TableCell className="text-right font-mono">{signedDollars(Math.round(Number(r.amount) * 100))}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.created_by}</TableCell>
                  <TableCell>
                    {voiding?.id === r.id ? (
                      <div className="flex items-center gap-2">
                        <input aria-label="Reason" placeholder="Reason" value={voiding.reason} onChange={(e) => setVoiding({ id: r.id, reason: e.target.value })}
                          className="w-40 rounded-md border border-border px-2 py-1 text-sm" />
                        <Button variant="danger" disabled={!voiding.reason.trim() || voidIt.isPending} onClick={() => voidIt.mutate(voiding)}>Void</Button>
                        <Button variant="ghost" onClick={() => setVoiding(null)}>Cancel</Button>
                      </div>
                    ) : <Button variant="ghost" onClick={() => setVoiding({ id: r.id, reason: '' })}>Void…</Button>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {voided.length > 0 && <p className="text-xs text-muted-foreground">{voided.length} voided balance forward{voided.length === 1 ? '' : 's'} kept for the record.</p>}
        </Card>
      )}

      {llc && (
        <Card className="space-y-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-foreground">Import from QuickBooks</h2>
            <p className="text-sm text-muted-foreground">
              In this LLC's QuickBooks file: Reports → Customers &amp; Receivables → A/R Aging Summary, dated the cut-off above. Export to Excel,
              keep the title rows (the "As of" date is checked) and the TOTAL row (checked), and save as CSV. Leases with no matching
              customer are taken as owing $0 in QuickBooks. You can also type a QuickBooks balance for any lease below, with or without a file.
            </p>
          </div>
          <FileDropZone onFile={(f) => void onFile(f)} accept={[]} maxBytes={BF_FILE_MAX_BYTES} hint="Drop the A/R Aging Summary .csv here, or click to browse" />
          <div className="flex flex-wrap items-center gap-3">
            {file && <span className="text-sm text-foreground">{file.name}</span>}
            <Button variant="ghost" disabled={run.isPending || badManual.length > 0} onClick={() => run.mutate(false)}>Preview</Button>
            {armed ? (
              <>
                <span className="text-sm text-foreground">Apply {plan?.adjust_count} balance forward{plan?.adjust_count === 1 ? '' : 's'} as of {plan?.as_of}?</span>
                <Button disabled={!canApply} onClick={() => run.mutate(true)}>Apply</Button>
                <Button variant="ghost" onClick={() => setArmed(false)}>Cancel</Button>
              </>
            ) : (
              <Button disabled={!canApply} onClick={() => setArmed(true)}>Apply…</Button>
            )}
          </div>

          {plan && (
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([
                  ['As of', plan.as_of],
                  ['File TOTAL', plan.file_total_cents === null ? 'no file' : signedDollars(plan.file_total_cents)],
                  ['Not matched to a lease', signedDollars(plan.unmatched_cents)],
                  ['Leases to adjust', String(plan.adjust_count)],
                ] as const).map(([k, v]) => (
                  <div key={k} className="rounded-md border border-border p-3">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="font-mono text-sm text-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
              {plan.errors.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-status-danger" aria-label="Problems">{plan.errors.map((m) => <li key={m}>{m}</li>)}</ul>}
              {plan.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-status-warning" aria-label="Warnings">{plan.warnings.map((m) => <li key={m}>{m}</li>)}</ul>}
              {plan.applied && <p className="text-sm text-foreground">Applied. Statements, the Collections page and the tenant portal now show these leases' QuickBooks balances.</p>}

              {plan.customers.some((cu) => cu.how !== 'auto') && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">QuickBooks customers to match</h3>
                  {plan.customers.filter((cu) => cu.how !== 'auto').map((cu) => (
                    <div key={cu.customer} className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="min-w-48">{cu.customer}</span>
                      <span className="font-mono">{signedDollars(cu.cents)}</span>
                      <select aria-label={`Lease for ${cu.customer}`} value={assign[cu.customer] ?? cu.lease_id ?? ''}
                        onChange={(e) => { setAssign({ ...assign, [cu.customer]: e.target.value }); reset() }}
                        className="rounded-md border border-border px-2 py-1 text-sm">
                        <option value="">Not in the app (leave out)</option>
                        {leaseOptions.map((l) => <option key={l.lease_id} value={l.lease_id}>{l.tenant_name}{l.suite ? `, suite ${l.suite}` : ''} — {l.property_name}</option>)}
                      </select>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">Preview again after matching.</p>
                </div>
              )}

              {plan.rows.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tenant</TableHead><TableHead>QuickBooks customer</TableHead><TableHead className="text-right">QuickBooks</TableHead>
                      <TableHead className="text-right">App</TableHead><TableHead className="text-right">Balance forward</TableHead><TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.rows.map((r) => (
                      <TableRow key={r.lease_id}>
                        <TableCell>{r.tenant_name}{r.suite ? `, suite ${r.suite}` : ''}<div className="text-xs text-muted-foreground">{r.property_name} · lease {r.lease_status}</div></TableCell>
                        <TableCell className="text-sm">{r.qb_customers.join('; ') || '—'}<div className="text-xs text-muted-foreground">{SOURCE_LABELS[r.qb_source]}</div></TableCell>
                        <TableCell className="text-right">
                          <input aria-label={`QuickBooks balance for ${r.tenant_name}`} inputMode="decimal" placeholder={r.status === 'no_figure' ? '—' : (r.qb_cents / 100).toFixed(2)}
                            value={manualText[r.lease_id] ?? ''} onChange={(e) => { setManualText({ ...manualText, [r.lease_id]: e.target.value }); reset() }}
                            className={`w-28 rounded-md border px-2 py-1 text-right font-mono text-sm ${badManual.includes(r.lease_id) ? 'border-status-danger' : 'border-border'}`} />
                        </TableCell>
                        <TableCell className="text-right font-mono">{signedDollars(r.app_cents)}</TableCell>
                        <TableCell className="text-right font-mono">{r.status === 'adjust' ? signedDollars(r.adjustment_cents) : '—'}</TableCell>
                        <TableCell className="text-sm">{STATUS_LABELS[r.status]}{r.note && <div className="text-xs text-muted-foreground">{r.note}</div>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
