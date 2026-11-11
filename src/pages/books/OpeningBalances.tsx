// B8 slice 2: Books › Opening balances. Per LLC: the ledger start date, the live opening balance
// (QuickBooks trial balance as of the day before), a CSV import with preview, and reversal for
// corrections (reverse, then import again). The server and database decide everything; this page
// shows the plan and the result.
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { FileDropZone } from '../../components/ui/FileDropZone'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { decodeIif } from './iif-file'
import { DEFAULT_START_MONTH, TB_MAX_BYTES, dollars, tbFileProblem } from './opening-balance-helpers'
import type { GlAccount, GlEntity } from './ChartOfAccounts'


type PlanLine = { row: number; account_id: string; number: string | null; qb_name: string; account_type: string; is_active: boolean; debit_cents: number; credit_cents: number }
export type ObPlan = {
  lines: PlanLine[]
  debit_cents: number
  credit_cents: number
  file_total: { debit_cents: number; credit_cents: number } | null
  skipped_zero_rows: number
  errors: string[]
  warnings: string[]
  plan_hash: string
  start_date: string
  as_of: string
  current_start_date: string | null
  live_opening_balance_id: string | null
  applied: boolean
  entry_id: string | null
}
type LiveOb = { id: string; entry_date: string; posted_by: string; posted_at: string; lines: { line_no: number; account_id: string; debit_cents: number; credit_cents: number }[] }
type ApiError = Error & { body?: { error?: unknown; data?: ObPlan } }


const h = dataTableColumnHelper<PlanLine>()
const LINE_COLUMNS = [
  h.accessor('number', { header: 'Number', enableSorting: true, cell: ({ row }) => <span className="font-mono">{row.original.number ?? '—'}</span> }),
  h.accessor('qb_name', { header: 'Account', enableSorting: true }),
  h.accessor('account_type', { header: 'Type', enableSorting: true }),
  h.accessor('debit_cents', { header: 'Debit', enableSorting: true, cell: ({ row }) => <span className="font-mono">{row.original.debit_cents ? dollars(row.original.debit_cents) : ''}</span> }),
  h.accessor('credit_cents', { header: 'Credit', enableSorting: true, cell: ({ row }) => <span className="font-mono">{row.original.credit_cents ? dollars(row.original.credit_cents) : ''}</span> }),
]

export function OpeningBalances() {
  const qc = useQueryClient()
  const entities = useQuery({ queryKey: ['gl', 'entities'], queryFn: () => api.get<{ data: GlEntity[] }>('/gl/entities') })
  const [entityId, setEntityId] = useState('')
  const status = useQuery({
    queryKey: ['gl', 'opening-balance', entityId],
    queryFn: () => api.get<{ data: { ledger_start_date: string | null; opening_balance: LiveOb | null } }>(`/gl/entities/${entityId}/opening-balance`),
    enabled: !!entityId,
  })
  const chart = useQuery({
    queryKey: ['gl', 'accounts', entityId],
    queryFn: () => api.get<{ data: GlAccount[] }>(`/gl/entities/${entityId}/accounts`),
    enabled: !!entityId,
  })

  const [month, setMonth] = useState(DEFAULT_START_MONTH)
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [plan, setPlan] = useState<ObPlan | null>(null)
  const [reverseArmed, setReverseArmed] = useState(false)
  const reset = () => { setPlan(null); setReverseArmed(false) }

  const live = status.data?.data.opening_balance ?? null
  const liveLines = useMemo<PlanLine[]>(() => {
    if (!live) return []
    const byId = new Map((chart.data?.data ?? []).map((a) => [a.id, a]))
    return live.lines.map((l) => {
      const a = byId.get(l.account_id)
      return { row: l.line_no, account_id: l.account_id, number: a?.number ?? null, qb_name: a?.qb_name ?? l.account_id, account_type: a?.account_type ?? '', is_active: a?.is_active ?? true, debit_cents: Number(l.debit_cents), credit_cents: Number(l.credit_cents) }
    })
  }, [live, chart.data])
  const liveTotal = liveLines.reduce((s, l) => s + l.debit_cents, 0)

  const run = useMutation({
    mutationFn: (apply: boolean) => api.post<{ data: ObPlan }>(`/gl/entities/${entityId}/opening-balance`,
      apply ? { csv: file?.text, start_date: `${month}-01`, apply, expected_plan_hash: plan?.plan_hash } : { csv: file?.text, start_date: `${month}-01` }),
    onSuccess: (res, apply) => {
      setPlan(res.data)
      if (apply) {
        toast.success(`Opening balance posted as of ${res.data.as_of}`)
        void qc.invalidateQueries({ queryKey: ['gl', 'opening-balance', entityId] })
      }
    },
    onError: (e: ApiError) => {
      if (e.body?.data && 'lines' in e.body.data) setPlan(e.body.data)
      toast.error(typeof e.body?.error === 'string' ? e.body.error : e.message)
    },
  })

  const reverse = useMutation({
    mutationFn: () => api.post<{ data: { id: string } }>(`/gl/journal/${live?.id}/reverse`, { entry_date: live?.entry_date, memo: 'Opening balance reversed for re-import' }),
    onSuccess: () => {
      toast.success('Opening balance reversed; import the corrected trial balance')
      setReverseArmed(false)
      void qc.invalidateQueries({ queryKey: ['gl', 'opening-balance', entityId] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const onFile = async (f: File) => {
    const problem = tbFileProblem(f)
    if (problem) { toast.error(problem); return }
    setFile({ name: f.name, text: decodeIif(await f.arrayBuffer()) })
    reset()
  }

  const canPost = !!plan && !plan.applied && plan.errors.length === 0 && !live && !run.isPending

  return (
    <div className="space-y-6">
      <PageHeader title="Opening balances" />

      <Card className="space-y-3 p-6">
        <label className="block text-sm font-medium text-foreground" htmlFor="ob-entity">Entity (LLC)</label>
        <select id="ob-entity" value={entityId} onChange={(e) => { setEntityId(e.target.value); setFile(null); reset() }}
          className="w-full max-w-md rounded-md border border-border px-3 py-2 text-sm">
          <option value="">Select an entity…</option>
          {entities.data?.data.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.accounting_basis})</option>)}
        </select>
        {entityId && status.data && (
          <p className="text-sm text-muted-foreground">
            Ledger start date: {status.data.data.ledger_start_date ?? 'not set'}{live ? ` · opening balance as of ${live.entry_date}, ${dollars(liveTotal)} each side` : ' · no opening balance yet'}
          </p>
        )}
      </Card>

      {entityId && live && (
        <Card className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">Opening balance as of {live.entry_date}</h2>
            {reverseArmed ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground">Reverse it on {live.entry_date}?</span>
                <Button variant="danger" disabled={reverse.isPending} onClick={() => reverse.mutate()}>Reverse opening balance</Button>
                <Button variant="ghost" onClick={() => setReverseArmed(false)}>Cancel</Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setReverseArmed(true)}>Correct it…</Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">To correct it, reverse it (on its own date), then import the corrected trial balance below.</p>
          <DataTable<PlanLine> mode="client" columns={LINE_COLUMNS} queryKey={['gl', 'ob-live', entityId]} rows={liveLines} getRowId={(r) => String(r.row)} emptyTitle="No lines" />
        </Card>
      )}

      {entityId && !live && (
        <Card className="space-y-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-foreground">Import from a QuickBooks trial balance</h2>
            <p className="text-sm text-muted-foreground">
              In this LLC's QuickBooks file: Reports → Accountant &amp; Taxes → Trial Balance, dated the day before the start date. Export to Excel,
              keep the report's title rows (they carry the "As of" date and basis, which are checked), rename the columns to exactly Account, Debit and Credit, keep the TOTAL row (it is required and checked), and save as CSV.
              Every account must already be in the chart (Books → Chart of accounts).
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground" htmlFor="ob-start">Ledger start month</label>
              <input id="ob-start" type="month" value={month} onChange={(e) => { setMonth(e.target.value); reset() }}
                className="rounded-md border border-border px-3 py-2 text-sm" />
            </div>
            <p className="text-sm text-muted-foreground">Opening balance dated the day before {month}-01.</p>
          </div>
          <FileDropZone onFile={(f) => void onFile(f)} accept={[]} maxBytes={TB_MAX_BYTES} hint="Drop the trial balance .csv here, or click to browse" />
          {file && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-foreground">{file.name}</span>
              <Button variant="ghost" disabled={run.isPending} onClick={() => run.mutate(false)}>Preview</Button>
              <Button disabled={!canPost} onClick={() => run.mutate(true)}>
                {plan && !plan.applied ? `Post opening balance (${dollars(plan.debit_cents)} each side)` : 'Post opening balance'}
              </Button>
            </div>
          )}
          {plan && (
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([
                  ['As of', plan.as_of],
                  ['Debits', dollars(plan.debit_cents)],
                  ['Credits', dollars(plan.credit_cents)],
                  ['File TOTAL row', plan.file_total ? `${dollars(plan.file_total.debit_cents)} / ${dollars(plan.file_total.credit_cents)}` : 'none'],
                ] as const).map(([k, v]) => (
                  <div key={k} className="rounded-md border border-border p-3">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="font-mono text-sm text-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
              {plan.errors.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-status-danger" aria-label="Problems">{plan.errors.map((m) => <li key={m}>{m}</li>)}</ul>
              )}
              {plan.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" aria-label="Warnings">{plan.warnings.map((m) => <li key={m}>{m}</li>)}</ul>
              )}
              {plan.applied && <p className="text-sm text-foreground">Posted. The ledger's trial balance as of {plan.as_of} should now tie to QuickBooks line for line.</p>}
              {plan.lines.length > 0 && !plan.applied && (
                <DataTable<PlanLine> mode="client" columns={LINE_COLUMNS} queryKey={['gl', 'ob-preview', entityId, file?.name, month]} rows={plan.lines} getRowId={(r) => String(r.row)} emptyTitle="No lines" />
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
