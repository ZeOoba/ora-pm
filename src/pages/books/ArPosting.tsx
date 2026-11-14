// B8 slices 3–4: Books › AR posting (accrual- and cash-basis LLCs). Per LLC: which properties belong to it,
// which chart account each AR role posts to, the one-time AR tie-out against the opening balance,
// and "post through <date>" runs with a preview. The server plans the run and the database builds
// and verifies every entry; this page shows the plan and the result.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { dollars } from './opening-balance-helpers'
import { AR_ROLE_LABELS, KIND_LABELS, centralToday, rolesForBasis, signedDollars } from './ar-posting-helpers'
import type { GlAccount, GlEntity } from './ChartOfAccounts'

type ArSetup = {
  accounting_basis: 'accrual' | 'cash'
  ledger_start_date: string | null
  roles: { role: string; account_id: string }[]
  tieout: { as_of: string; app_ar_cents: number; gl_ar_cents: number; confirmed_by: string; confirmed_at: string } | null
  properties: { id: string; name: string; gl_entity_id: string | null }[]
  /** 0032: the LLC's live balance forwards from QuickBooks (Books › Balance forward). */
  balance_forwards?: { cutoff: string | null; live_count: number; count: number; net_cents: number; positive_cents: number; negative_cents: number; after_cutoff: { lease_id: string; as_of: string; amount_cents: number }[] }
}
type ArItem = { kind: string; source_id: string; lease_id: string; date: string; cents: number; label: string; debit_role: string; credit_role: string }
export type ArRun = {
  items: ArItem[]
  attention: { source_id: string; kind: string; message: string }[]
  skipped: number
  errors: string[]
  by_role: Record<string, number>
  through: string
  plan_hash: string
  applied: boolean
  posted: number
}
type ApiError = Error & { body?: { error?: unknown; data?: ArRun } }
const errText = (e: ApiError) => (typeof e.body?.error === 'string' ? e.body.error : e.message)

const h = dataTableColumnHelper<ArItem>()
const ITEM_COLUMNS = [
  h.accessor('date', { header: 'Date', enableSorting: true, cell: ({ row }) => <span className="font-mono">{row.original.date}</span> }),
  h.accessor('kind', { header: 'Kind', enableSorting: true, cell: ({ row }) => KIND_LABELS[row.original.kind] ?? row.original.kind }),
  h.accessor('label', { header: 'Item', enableSorting: true }),
  h.accessor('debit_role', { header: 'Debit', enableSorting: true, cell: ({ row }) => row.original.debit_role.replace(/_/g, ' ') }),
  h.accessor('credit_role', { header: 'Credit', enableSorting: true, cell: ({ row }) => row.original.credit_role.replace(/_/g, ' ') }),
  h.accessor('cents', { header: 'Amount', enableSorting: true, cell: ({ row }) => <span className="font-mono">{dollars(row.original.cents)}</span> }),
]
const roleLabel = (r: string) => AR_ROLE_LABELS.find((x) => x.role === r)?.label ?? r.replace(/_/g, ' ')

export function ArPosting() {
  const qc = useQueryClient()
  const entities = useQuery({ queryKey: ['gl', 'entities'], queryFn: () => api.get<{ data: GlEntity[] }>('/gl/entities') })
  const [entityId, setEntityId] = useState('')
  const setup = useQuery({
    queryKey: ['gl', 'ar', entityId],
    queryFn: () => api.get<{ data: ArSetup }>(`/gl/entities/${entityId}/ar`),
    enabled: !!entityId,
  })
  const chart = useQuery({
    queryKey: ['gl', 'accounts', entityId],
    queryFn: () => api.get<{ data: GlAccount[] }>(`/gl/entities/${entityId}/accounts`),
    enabled: !!entityId,
  })
  const [through, setThrough] = useState(centralToday())
  const [run, setRun] = useState<ArRun | null>(null)
  const [tieArmed, setTieArmed] = useState(false)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['gl', 'ar', entityId] })

  const s = setup.data?.data
  const cash = s?.accounting_basis === 'cash'
  const bf = s?.balance_forwards
  const roleMap = new Map((s?.roles ?? []).map((r) => [r.role, r.account_id]))
  const accounts = chart.data?.data ?? []

  const saveRole = useMutation({
    mutationFn: ({ role, account_id }: { role: string; account_id: string | null }) => api.put(`/gl/entities/${entityId}/ar/accounts`, { roles: { [role]: account_id } }),
    onSuccess: () => { setRun(null); refresh() },
    onError: (e: ApiError) => toast.error(errText(e)),
  })
  const assign = useMutation({
    mutationFn: ({ property_id, assigned }: { property_id: string; assigned: boolean }) => api.put(`/gl/entities/${entityId}/ar/properties`, { property_id, assigned }),
    onSuccess: () => { setRun(null); refresh() },
    onError: (e: ApiError) => toast.error(errText(e)),
  })
  const tieout = useMutation({
    mutationFn: () => api.post<{ data: { app_ar_cents: number } }>(`/gl/entities/${entityId}/ar/tieout`, {}),
    onSuccess: (res) => { toast.success(`AR tie-out confirmed at ${dollars(Number(res.data.app_ar_cents))}`); setTieArmed(false); refresh() },
    onError: (e: ApiError) => { toast.error(errText(e)); setTieArmed(false) },
  })
  const plan = useMutation({
    mutationFn: (apply: boolean) => api.post<{ data: ArRun }>(`/gl/entities/${entityId}/ar/run`, apply ? { through, apply, expected_plan_hash: run?.plan_hash } : { through }),
    onSuccess: (res, apply) => {
      setRun(res.data)
      if (apply) toast.success(`Posted ${res.data.posted} item${res.data.posted === 1 ? '' : 's'} through ${res.data.through}`)
    },
    onError: (e: ApiError) => {
      if (e.body?.data && 'items' in e.body.data) setRun(e.body.data)
      else setRun(null)
      toast.error(errText(e))
    },
  })

  const canPost = !!run && !run.applied && run.errors.length === 0 && run.items.length > 0 && run.through === through && !plan.isPending

  return (
    <div className="space-y-6">
      <PageHeader title="AR posting" />

      <Card className="space-y-3 p-6">
        <label className="block text-sm font-medium text-foreground" htmlFor="ar-entity">Entity (LLC)</label>
        <select id="ar-entity" value={entityId} onChange={(e) => { setEntityId(e.target.value); setRun(null); setTieArmed(false) }}
          className="w-full max-w-md rounded-md border border-border px-3 py-2 text-sm">
          <option value="">Select an entity…</option>
          {entities.data?.data.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.accounting_basis})</option>)}
        </select>
        {s && (
          <p className="text-sm text-muted-foreground">
            Ledger start date: {s.ledger_start_date ?? 'not set'}
            {s.tieout ? ` · ${cash ? 'tenant credits' : 'AR'} tied out at ${dollars(Number(s.tieout.app_ar_cents))} as of ${s.tieout.as_of}` : ' · AR not tied out yet'}
          </p>
        )}
        {s && cash && (
          <p className="text-sm text-muted-foreground">
            Cash basis: a charge is income only as cash pays it. Cash pays charges in the order they were billed, oldest due date first within a billing date (deposit, rent, CAM, utilities, other, late fees last); cash beyond that is a tenant credit in prepaid rent.
          </p>
        )}
      </Card>

      {s && (
        <>
          <Card className="space-y-3 p-6">
            <h2 className="text-base font-semibold text-foreground">Properties</h2>
            <p className="text-sm text-muted-foreground">Charges and payments post to the LLC that owns the property. A property's LLC is fixed once any of its AR is tied out or posted.</p>
            <ul className="space-y-2">
              {s.properties.map((p) => (
                <li key={p.id} className="flex items-center gap-3 text-sm">
                  <input id={`ar-prop-${p.id}`} type="checkbox" checked={p.gl_entity_id === entityId} disabled={assign.isPending}
                    onChange={(e) => assign.mutate({ property_id: p.id, assigned: e.target.checked })} />
                  <label htmlFor={`ar-prop-${p.id}`} className="text-foreground">{p.name}</label>
                </li>
              ))}
              {s.properties.length === 0 && <li className="text-sm text-muted-foreground">No unassigned properties.</li>}
            </ul>
          </Card>

          <Card className="space-y-3 p-6">
            <h2 className="text-base font-semibold text-foreground">Accounts</h2>
            <p className="text-sm text-muted-foreground">The chart account each kind of AR activity posts to. AR and undeposited funds are fixed once anything has posted.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {rolesForBasis(s.accounting_basis).map(({ role, label, type }) => (
                <div key={role}>
                  <label className="block text-xs text-muted-foreground" htmlFor={`ar-role-${role}`}>{label} ({type})</label>
                  <select id={`ar-role-${role}`} value={roleMap.get(role) ?? ''} disabled={saveRole.isPending}
                    onChange={(e) => saveRole.mutate({ role, account_id: e.target.value || null })}
                    className="w-full rounded-md border border-border px-3 py-2 text-sm">
                    <option value="">{role === 'balance_forward' ? 'Same as Rent (default)' : 'Not mapped'}</option>
                    {accounts.filter((a) => a.account_type === type && (a.is_active || a.id === roleMap.get(role))).map((a) => (
                      <option key={a.id} value={a.id}>{a.number ? `${a.number} ` : ''}{a.qb_name}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </Card>

          {!s.tieout && (
            <Card className="space-y-3 p-6">
              <h2 className="text-base font-semibold text-foreground">AR tie-out</h2>
              <p className="text-sm text-muted-foreground">
                {cash
                  ? 'Before anything posts, the app\'s tenant credits as of the day before the start date (cash received beyond charges, lease by lease) must equal the prepaid rent account in the opening balance, and paid pre-start security deposits the deposits account, to the cent. Map prepaid rent and security deposits and assign this LLC\'s properties first.'
                  : 'Before anything posts, the app\'s open AR as of the day before the start date must equal the AR account in the opening balance, to the cent. Map the AR account and assign this LLC\'s properties first.'}
                {' '}If it does not tie, the message gives both numbers; fix the difference in QuickBooks or the app and re-import the opening balance. Once confirmed, the opening balance can no longer be reversed.
              </p>
              {bf && bf.live_count > 0 && !bf.cutoff && (
                <p className="text-sm text-muted-foreground">{bf.live_count} balance forward{bf.live_count === 1 ? '' : 's'} from QuickBooks: whether they count depends on the ledger start date (set it first).</p>
              )}
              {bf && bf.count > 0 && (
                <p className="text-sm text-muted-foreground" aria-label="Balance forwards">
                  {bf.count} balance forward{bf.count === 1 ? '' : 's'} from QuickBooks (net {signedDollars(bf.net_cents)}) count in this tie-out
                  {cash ? ': amounts owed are paid by later cash before newer charges (income to the balance forward account, or Rent), credits count as tenant credits' : ' as part of open AR'}.
                  {' '}Once confirmed they can no longer be voided, and no new ones can be imported for this LLC.
                </p>
              )}
              {bf && bf.after_cutoff.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-status-danger" aria-label="Balance forwards after the cut-off">
                  {bf.after_cutoff.map((b) => <li key={b.lease_id}>Balance forward dated {b.as_of} ({signedDollars(b.amount_cents)}) is after the tie-out date; void it and import it again as of the day before {s.ledger_start_date} or earlier.</li>)}
                </ul>
              )}
              {tieArmed ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">Confirm the tie-out? This is recorded once per LLC.</span>
                  <Button disabled={tieout.isPending} onClick={() => tieout.mutate()}>Confirm tie-out</Button>
                  <Button variant="ghost" onClick={() => setTieArmed(false)}>Cancel</Button>
                </div>
              ) : (
                <Button variant="ghost" onClick={() => setTieArmed(true)} disabled={!s.ledger_start_date || !roleMap.get(cash ? 'prepaid_rent' : 'ar') || (bf?.after_cutoff.length ?? 0) > 0}>Check and confirm tie-out…</Button>
              )}
            </Card>
          )}

          {s.tieout && (
            <Card className="space-y-4 p-6">
              <h2 className="text-base font-semibold text-foreground">Post to the ledger</h2>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground" htmlFor="ar-through">Post through</label>
                  <input id="ar-through" type="date" value={through} min={s.ledger_start_date ?? undefined} max={centralToday()}
                    onChange={(e) => { setThrough(e.target.value); setRun(null) }} className="rounded-md border border-border px-3 py-2 text-sm" />
                </div>
                <Button variant="ghost" disabled={plan.isPending || !through} onClick={() => plan.mutate(false)}>Preview</Button>
                <Button disabled={!canPost} onClick={() => plan.mutate(true)}>
                  {run && !run.applied && run.items.length ? `Post ${run.items.length} item${run.items.length === 1 ? '' : 's'}` : 'Post'}
                </Button>
              </div>
              {run && (
                <div className="space-y-3">
                  {run.applied && <p className="text-sm text-foreground">{run.posted ? `Posted ${run.posted} item${run.posted === 1 ? '' : 's'} through ${run.through}.` : `Nothing to post through ${run.through}.`}</p>}
                  {!run.applied && run.items.length === 0 && run.errors.length === 0 && <p className="text-sm text-muted-foreground">Nothing to post through {run.through}.</p>}
                  {run.errors.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-status-danger" aria-label="Problems">{run.errors.map((m) => <li key={m}>{m}</li>)}</ul>
                  )}
                  {run.attention.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium text-foreground">Needs attention (not posted)</h3>
                      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" aria-label="Needs attention">{run.attention.map((a) => <li key={`${a.kind}:${a.source_id}`}>{a.message}</li>)}</ul>
                    </div>
                  )}
                  {!run.applied && Object.keys(run.by_role).length > 0 && (
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Net change by account">
                      {Object.entries(run.by_role).map(([r, c]) => (
                        <div key={r} className="rounded-md border border-border p-3">
                          <dt className="text-xs text-muted-foreground">{roleLabel(r)}</dt>
                          <dd className="font-mono text-sm text-foreground">{signedDollars(c)}{c > 0 ? ' Dr' : c < 0 ? ' Cr' : ''}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {!run.applied && run.items.length > 0 && (
                    <DataTable<ArItem> mode="client" columns={ITEM_COLUMNS} queryKey={['gl', 'ar-preview', entityId, run.through, run.plan_hash]} rows={run.items} getRowId={(r) => `${r.kind}:${r.source_id}`} emptyTitle="Nothing to post" />
                  )}
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  )
}
