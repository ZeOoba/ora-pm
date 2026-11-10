// B8 slice 1: Books › Chart of accounts. Pick (or create) an LLC's ledger entity, see its chart,
// and import the LLC's QuickBooks Desktop chart from an IIF export: preview first, then import.
// The server decides everything (account types, conflicts); this page only shows the plan.
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { FileDropZone } from '../../components/ui/FileDropZone'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { decodeIif, iifFileProblem, IIF_MAX_BYTES } from './iif-file'

export type GlEntity = { id: string; name: string; accounting_basis: 'accrual' | 'cash'; qb_file_name: string | null }
export type GlAccount = { id: string; number: string | null; qb_name: string; account_type: string; qb_account_type: string | null; is_active: boolean }
type PlanAccount = { line: number; qb_name: string; number: string | null; qb_account_type: string; account_type: string; is_active: boolean }
export type ImportPlan = {
  new: PlanAccount[]
  unchanged: PlanAccount[]
  conflicts: { qb_name: string; line: number; reasons: string[] }[]
  warnings: { qb_name: string; line: number; message: string }[]
  ledger_only: { qb_name: string; number: string | null }[]
  skipped: { line: number; qb_name: string; reason: string }[]
  applied: boolean
  inserted: number
}
type ApiError = Error & { body?: { error?: unknown; data?: { errors?: string[] } & Partial<ImportPlan> } }

const acct = dataTableColumnHelper<GlAccount>()
const ACCOUNT_COLUMNS = [
  acct.accessor('number', { header: 'Number', enableSorting: true, cell: ({ row }) => <span className="font-mono">{row.original.number ?? '—'}</span> }),
  acct.accessor('qb_name', { header: 'QuickBooks name', enableSorting: true }),
  acct.accessor('account_type', { header: 'Type', enableSorting: true }),
  acct.accessor((r) => r.qb_account_type ?? '', { id: 'qb_account_type', header: 'QB type', enableSorting: true, cell: ({ row }) => row.original.qb_account_type ?? '—' }),
  acct.accessor((r) => (r.is_active ? 'Active' : 'Inactive'), { id: 'status', header: 'Status', cell: ({ row }) => <Badge tone={row.original.is_active ? 'active' : 'neutral'}>{row.original.is_active ? 'Active' : 'Inactive'}</Badge> }),
]

const plan = dataTableColumnHelper<PlanAccount>()
const PLAN_COLUMNS = [
  plan.accessor('line', { header: 'Line', enableSorting: true }),
  plan.accessor('number', { header: 'Number', enableSorting: true, cell: ({ row }) => <span className="font-mono">{row.original.number ?? '—'}</span> }),
  plan.accessor('qb_name', { header: 'QuickBooks name', enableSorting: true }),
  plan.accessor('qb_account_type', { header: 'QB type', enableSorting: true }),
  plan.accessor('account_type', { header: 'Ledger type', enableSorting: true }),
  plan.accessor((r) => (r.is_active ? 'Active' : 'Inactive'), { id: 'status', header: 'Status' }),
]

export function ChartOfAccounts() {
  const qc = useQueryClient()
  const entities = useQuery({ queryKey: ['gl', 'entities'], queryFn: () => api.get<{ data: GlEntity[] }>('/gl/entities') })
  const [entityId, setEntityId] = useState('')
  const entity = entities.data?.data.find((e) => e.id === entityId)

  const accounts = useQuery({
    queryKey: ['gl', 'accounts', entityId],
    queryFn: () => api.get<{ data: GlAccount[] }>(`/gl/entities/${entityId}/accounts`),
    enabled: !!entityId,
  })

  const [iif, setIif] = useState<{ name: string; text: string } | null>(null)
  const [preview, setPreview] = useState<ImportPlan | null>(null)
  const [fileErrors, setFileErrors] = useState<string[]>([])

  const run = useMutation({
    mutationFn: (apply: boolean) => api.post<{ data: ImportPlan }>(`/gl/entities/${entityId}/accounts/qb-iif`,
      apply ? { iif: iif?.text, apply, expected_new: preview?.new.length } : { iif: iif?.text, apply }),
    onSuccess: (res, apply) => {
      setPreview(res.data)
      setFileErrors([])
      if (apply) {
        toast.success(`Imported ${res.data.inserted} ${res.data.inserted === 1 ? 'account' : 'accounts'}`)
        void qc.invalidateQueries({ queryKey: ['gl', 'accounts', entityId] })
      }
    },
    onError: (e: ApiError) => {
      const data = e.body?.data
      setFileErrors(data?.errors ?? [])
      setPreview(data && 'new' in data ? (data as ImportPlan) : null)
      toast.error(typeof e.body?.error === 'string' ? e.body.error : e.message)
    },
  })

  const onFile = async (file: File) => {
    const problem = iifFileProblem(file)
    if (problem) {
      toast.error(problem)
      return
    }
    const text = decodeIif(await file.arrayBuffer())
    setIif({ name: file.name, text })
    setPreview(null)
    setFileErrors([])
  }

  const counts = useMemo(() => preview && [
    ['New', preview.new.length],
    ['Unchanged', preview.unchanged.length],
    ['Conflicts', preview.conflicts.length],
    ['Warnings', preview.warnings.length],
    ['Only in the ledger', preview.ledger_only.length],
    ['Skipped (non-posting)', preview.skipped.length],
  ] as const, [preview])

  return (
    <div className="space-y-6">
      <PageHeader title="Chart of accounts" />

      <Card className="space-y-3 p-6">
        <label className="block text-sm font-medium text-foreground" htmlFor="gl-entity">Entity (LLC)</label>
        <select
          id="gl-entity"
          value={entityId}
          onChange={(e) => { setEntityId(e.target.value); setPreview(null); setIif(null); setFileErrors([]) }}
          className="w-full max-w-md rounded-md border border-border px-3 py-2 text-sm"
        >
          <option value="">Select an entity…</option>
          {entities.data?.data.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.accounting_basis})</option>)}
        </select>
        {entities.data && (
          <details open={entities.data.data.length === 0} className="text-sm">
            <summary className="cursor-pointer text-foreground">Add an entity</summary>
            <NewEntityForm onCreated={(id) => setEntityId(id)} />
          </details>
        )}
        {entity && <p className="text-sm text-muted-foreground">QuickBooks file: {entity.qb_file_name ?? 'not recorded'}</p>}
      </Card>

      {entityId && (
        <>
          <Card className="space-y-4 p-6">
            <div>
              <h2 className="text-base font-semibold text-foreground">Import from QuickBooks Desktop</h2>
              <p className="text-sm text-muted-foreground">
                In this LLC's QuickBooks file: File → Utilities → Export → Lists to IIF Files, tick Chart of Accounts only, then drop the .IIF here.
                Preview shows what would change. Import adds new accounts only; it never edits or removes existing ones.
              </p>
            </div>
            <FileDropZone onFile={(f) => void onFile(f)} accept={[]} maxBytes={IIF_MAX_BYTES} hint="Drop the chart-of-accounts .IIF file here, or click to browse" />
            {iif && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-foreground">{iif.name}</span>
                <Button variant="ghost" disabled={run.isPending} onClick={() => run.mutate(false)}>Preview</Button>
                <Button
                  disabled={run.isPending || !preview || preview.applied || preview.conflicts.length > 0 || preview.new.length === 0}
                  onClick={() => run.mutate(true)}
                >
                  {preview && !preview.applied ? `Import ${preview.new.length} new ${preview.new.length === 1 ? 'account' : 'accounts'}` : 'Import'}
                </Button>
              </div>
            )}
            {fileErrors.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-status-danger" aria-label="File problems">
                {fileErrors.map((m) => <li key={m}>{m}</li>)}
              </ul>
            )}
            {preview && counts && (
              <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {counts.map(([label, n]) => (
                    <div key={label} className="rounded-md border border-border p-3">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="font-mono text-lg text-foreground">{n}</dd>
                    </div>
                  ))}
                </dl>
                {preview.applied && <p className="text-sm text-foreground">Imported {preview.inserted} {preview.inserted === 1 ? 'account' : 'accounts'}.</p>}
                {preview.conflicts.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-status-danger">Conflicts — nothing can be imported until these are resolved in QuickBooks or the ledger</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                      {preview.conflicts.map((c) => <li key={c.qb_name}>Line {c.line}, {c.qb_name}: {c.reasons.join('; ')}</li>)}
                    </ul>
                  </div>
                )}
                {preview.warnings.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Warnings (not blocking)</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {preview.warnings.map((w) => <li key={`${w.qb_name}-${w.message}`}>Line {w.line}, {w.qb_name}: {w.message}</li>)}
                    </ul>
                  </div>
                )}
                {!preview.applied && preview.new.length > 0 && (
                  <DataTable<PlanAccount>
                    mode="client"
                    columns={PLAN_COLUMNS}
                    queryKey={['gl', 'import-preview', entityId, iif?.name]}
                    rows={preview.new}
                    getRowId={(r) => String(r.line)}
                    emptyTitle="No new accounts"
                  />
                )}
              </div>
            )}
          </Card>

          <DataTable<GlAccount>
            mode="client"
            columns={ACCOUNT_COLUMNS}
            queryKey={['gl', 'accounts-table', entityId]}
            rows={accounts.data?.data}
            error={accounts.error}
            onRetry={() => void accounts.refetch()}
            clientSearchFn={(r, q) => `${r.number ?? ''} ${r.qb_name}`.toLowerCase().includes(q.toLowerCase())}
            searchPlaceholder="Search number or name…"
            emptyTitle="No accounts yet — import this LLC's QuickBooks chart above"
          />
        </>
      )}
    </div>
  )
}

function NewEntityForm({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual')
  const [qbFile, setQbFile] = useState('')
  const create = useMutation({
    mutationFn: () => api.post<{ data: GlEntity }>('/gl/entities', { name: name.trim(), accounting_basis: basis, qb_file_name: qbFile.trim() || null }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['gl', 'entities'] })
      onCreated(res.data.id)
      toast.success(`Created ${res.data.name}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <form className="mt-2 grid max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
      <p className="mt-2 text-sm text-muted-foreground">One entity per LLC. Its basis must match the LLC's QuickBooks file and cannot change once it has entries.</p>
      <input aria-label="LLC name" placeholder="LLC name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border border-border px-3 py-2 text-sm" />
      <select aria-label="Accounting basis" value={basis} onChange={(e) => setBasis(e.target.value as 'accrual' | 'cash')} className="rounded-md border border-border px-3 py-2 text-sm">
        <option value="accrual">Accrual</option>
        <option value="cash">Cash</option>
      </select>
      <input aria-label="QuickBooks file name" placeholder="QuickBooks file name (optional)" value={qbFile} onChange={(e) => setQbFile(e.target.value)} className="rounded-md border border-border px-3 py-2 text-sm" />
      <Button type="submit" disabled={!name.trim() || create.isPending}>Add entity</Button>
    </form>
  )
}
