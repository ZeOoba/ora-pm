import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { ApiError } from '../../lib/api-error'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Field } from '../../components/form/Field'
import { TextInput, NumberInput, DateInput, Textarea, Select } from '../../components/form/inputs'
import type { Tenant } from '../../types'
import {
  confirmationKey, dayBefore, defaultLeaseNotes, money, provisionLabel, setCited, REVIEWER_QUOTE, PROVISION_CATEGORY_OPTIONS, withOneRetry,
  type BillingProblem, type Confirmation, type Flag, type LeaseAbstract,
} from './abstract-review-helpers'

export interface AbstractResponse {
  abstract: LeaseAbstract
  flags: Flag[]
  confirmations: Confirmation[]
  warnings: string[]
  model?: string
  billing_problems?: BillingProblem[]
}

export interface OccupantLease { id: string; start_date: string; end_date: string; status: string; tenant_name: string }

interface Props {
  result: AbstractResponse
  filename: string
  pdfBase64: string
  unitId: string
  unitLabel: string
  presetTenantId: string
  tenants: Tenant[]
  occupants: OccupantLease[]
  onCancel: () => void
}

const ENTITY = ['llc', 'corporation', 'partnership', 'sole_proprietorship', 'individual', 'nonprofit', 'other']

export function AbstractReview({ result, filename, pdfBase64, unitId, unitLabel, presetTenantId, tenants, occupants, onCancel }: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [a, setA] = useState<LeaseAbstract>(result.abstract)
  const [flags, setFlags] = useState<Flag[]>(result.flags)
  const [confs, setConfs] = useState<Confirmation[]>(result.confirmations)
  const [warnings] = useState<string[]>(result.warnings)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // Starts dirty: the screen re-checks on open against the PDF, so it shows exactly what approval enforces.
  const [dirty, setDirty] = useState(true)
  // Months monthly billing cannot bill this schedule (it bills the lease's own schedule; Phase 7).
  const [problems, setProblems] = useState<BillingProblem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [tenantMode, setTenantMode] = useState<'new' | 'existing'>(presetTenantId ? 'existing' : 'new')
  const [existingId, setExistingId] = useState(presetTenantId)
  const [newTenant, setNewTenant] = useState({
    name: result.abstract.tenant_dba?.value ?? result.abstract.tenant_legal_name?.value ?? '',
    contact_name: '', contact_email: '', contact_phone: '',
  })
  const [replaceId, setReplaceId] = useState((occupants.find((o) => o.status === 'active') ?? occupants[0])?.id ?? '')
  const occupant = occupants.find((o) => o.id === replaceId) ?? null
  const startDate = a.rent_commencement_date?.value ?? a.commencement_date?.value ?? ''
  const [replace, setReplace] = useState(occupants.length > 0)
  const [replaceEnd, setReplaceEnd] = useState(startDate ? dayBefore(startDate) : '')
  const [notes, setNotes] = useState(() => defaultLeaseNotes(result.abstract, filename))

  const blocks = flags.filter((f) => f.severity === 'block')
  const unconfirmed = confs.filter((c) => !checked.has(confirmationKey(c)))

  // Counts edits so a re-check response never overwrites edits typed while it was in flight (REFUTE: the
  // retry's 1.5 s delay widened that window).
  const editSeq = useRef(0)
  function edit(next: (draft: LeaseAbstract) => void) {
    editSeq.current++
    setA((prev) => { const d = structuredClone(prev); next(d); return d })
    setDirty(true)
  }

  /** Server re-check (no egress, no writes). Returns the result so approve() never acts on state captured
   *  before the await (REFUTE C1b); null on failure. */
  async function recheck(): Promise<AbstractResponse | null> {
    setBusy(true); setError('')
    try {
      // One retry on a server or network error (live run 2026-11-23: the on-open re-check got a transient 503
      // right after a long extraction and left the confirmations locked). A 4xx is a real answer: no retry.
      const seq = editSeq.current
      const r = await withOneRetry(() => api.post<AbstractResponse>('/intake/lease/recheck', { abstract: a, pdfBase64 }))
      // Edited meanwhile: keep the newer edits (still dirty) and let the next re-check cover them.
      if (editSeq.current !== seq) return null
      setA(r.abstract); setFlags(r.flags); setConfs(r.confirmations); setProblems(r.billing_problems ?? [])
      if (r.warnings.length > 0) setError(r.warnings.join(' '))
      // Keys are content: a tick survives only for a confirmation that is byte-identical to what was checked.
      const keys = new Set(r.confirmations.map(confirmationKey))
      setChecked((prev) => new Set([...prev].filter((k) => keys.has(k))))
      setDirty(false)
      return r.warnings.length === 0 ? r : null
    } catch (e) {
      setError((e as Error).message); return null
    } finally { setBusy(false) }
  }

  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    void recheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, [])

  async function approve() {
    setError('')
    let current = confs
    if (dirty) {
      const r = await recheck()
      if (!r) return
      current = r.confirmations
      if (r.flags.some((f) => f.severity === 'block')) { setError('Resolve the blocking issues shown above.'); return }
      if (current.some((c) => !checked.has(confirmationKey(c)))) { setError('Your edits changed values to confirm; tick them below, then approve.'); return }
      if ((r.billing_problems ?? []).length > 0) { setError('Billing cannot bill this schedule in the months listed below; correct it first.'); return }
    }
    setBusy(true)
    try {
      const tenant = tenantMode === 'new' ? { mode: 'new' as const, ...newTenant } : { mode: 'existing' as const, id: existingId }
      const r = await api.post<{ outcome: string; lease_id: string; prior_charges_after_end?: number }>('/intake/lease/approve', {
        filename, pdfBase64, unit_id: unitId, tenant,
        replace: replace && occupant ? { lease_id: occupant.id, end_date: replaceEnd } : null,
        abstract: a, confirmed_keys: current.filter((c) => checked.has(confirmationKey(c))).map(confirmationKey),
        notes, model: result.model,
      })
      await qc.invalidateQueries()
      const extra = r.prior_charges_after_end ? `?priorCharges=${r.prior_charges_after_end}` : ''
      navigate(`/leases/${r.lease_id}${extra}`)
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { flags?: Flag[]; missing?: string[]; warnings?: string[]; billing_problems?: BillingProblem[] } | null) : null
      if (body?.flags) setFlags(body.flags)
      if (body?.billing_problems) setProblems(body.billing_problems)
      const detail = body?.missing ? ` Unconfirmed: ${body.missing.join(', ')}.` : body?.warnings ? ` ${body.warnings.join(' ')}` : ''
      setError((e as Error).message + detail)
    } finally { setBusy(false) }
  }

  const canApprove = !busy && unconfirmed.length === 0 && (dirty || blocks.length === 0) && problems.length === 0
    && (tenantMode === 'new' ? newTenant.name.trim() !== '' : existingId !== '')
    && (!replace || replaceEnd !== '')

  const flagsFor = useMemo(() => (path: string) => flags.filter((f) => f.path === path || f.path.startsWith(`${path}.`) || f.path.startsWith(`${path}[`)), [flags])

  return (
    <div className="max-w-5xl">
      <PageHeader title="Review Lease Abstract" subtitle={`${filename} · ${unitLabel}`} />

      {(warnings.length > 0 || flags.length > 0) && (
        <Card variant="default" className="p-4 mb-4">
          <ul className="text-sm space-y-1">
            {flags.map((f, i) => (
              <li key={`f${i}`} className={f.severity === 'block' ? 'text-status-danger' : 'text-status-warning'}>
                <span className="font-mono text-xs mr-2">{f.severity === 'block' ? 'BLOCK' : 'CHECK'} {f.path}</span>{f.message}
              </li>
            ))}
            {warnings.map((w, i) => <li key={`w${i}`} className="text-status-warning">{w}</li>)}
          </ul>
        </Card>
      )}

      <Section title="Tenant">
        <div className="flex gap-6 mb-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={tenantMode === 'new'} onChange={() => setTenantMode('new')} /> Create new tenant from this lease</label>
          <label className="flex items-center gap-2"><input type="radio" checked={tenantMode === 'existing'} onChange={() => setTenantMode('existing')} /> Existing tenant</label>
        </div>
        {tenantMode === 'new' ? (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Tenant name (display)" required><TextInput value={newTenant.name} onChange={(e) => setNewTenant({ ...newTenant, name: e.target.value })} /></Field>
            <Field label="Contact name"><TextInput value={newTenant.contact_name} onChange={(e) => setNewTenant({ ...newTenant, contact_name: e.target.value })} /></Field>
            <Field label="Contact email"><TextInput type="email" value={newTenant.contact_email} onChange={(e) => setNewTenant({ ...newTenant, contact_email: e.target.value })} /></Field>
            <Field label="Contact phone"><TextInput value={newTenant.contact_phone} onChange={(e) => setNewTenant({ ...newTenant, contact_phone: e.target.value })} /></Field>
          </div>
        ) : (
          <Field label="Tenant" required>
            <Select value={existingId} onChange={(e) => setExistingId(e.target.value)}>
              <option value="">Select tenant…</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-4 mt-2">
          <TextFact label="Legal name" v={a.tenant_legal_name?.value} onChange={(v) => edit((d) => { d.tenant_legal_name = setCited(v, d.tenant_legal_name) })} />
          <TextFact label="DBA" v={a.tenant_dba?.value} onChange={(v) => edit((d) => { d.tenant_dba = setCited(v, d.tenant_dba) })} />
          <Field label="Entity type">
            <Select value={a.tenant_entity_type?.value ?? ''} onChange={(e) => edit((d) => { d.tenant_entity_type = setCited(e.target.value || null, d.tenant_entity_type) })}>
              <option value="">—</option>
              {ENTITY.map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
            </Select>
          </Field>
          <TextFact label="State of formation" v={a.tenant_state_of_formation?.value} onChange={(v) => edit((d) => { d.tenant_state_of_formation = setCited(v, d.tenant_state_of_formation) })} />
          <TextFact label="Notice address" v={a.notice_address?.value} onChange={(v) => edit((d) => { d.notice_address = setCited(v, d.notice_address) })} />
          <TextFact label="Guarantor" v={a.guarantor_name?.value} onChange={(v) => edit((d) => { d.guarantor_name = setCited(v, d.guarantor_name) })} />
        </div>
        {tenantMode === 'existing' && <p className="text-xs text-status-neutral">Party fields stated in the lease update the existing tenant; blank fields leave the current value.</p>}
      </Section>

      <Section title={`Unit · ${unitLabel}`}>
        {occupants.length > 0 ? (
          <>
            {occupants.length === 1 && occupant ? (
              <p className="text-sm mb-3">Current tenant: <strong>{occupant.tenant_name}</strong> · lease {occupant.start_date} → {occupant.end_date} ({occupant.status})</p>
            ) : (
              <Field label="Lease to replace">
                <Select value={replaceId} onChange={(e) => setReplaceId(e.target.value)}>
                  {occupants.map((o) => <option key={o.id} value={o.id}>{o.tenant_name} · {o.start_date} → {o.end_date} ({o.status})</option>)}
                </Select>
              </Field>
            )}
            <label className="flex items-center gap-2 text-sm mb-3">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              Replace the current tenant with this lease
            </label>
            {replace && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Prior tenant's last day" required><DateInput value={replaceEnd} onChange={(e) => setReplaceEnd(e.target.value)} /></Field>
                <p className="text-xs text-status-neutral self-end pb-3">
                  The prior lease is end-dated (never extended) and closed out with a move-out. The prior tenant&apos;s record,
                  charges and payment history stay intact for statements and AR. Charges already posted after this date are reported for review.
                </p>
              </div>
            )}
          </>
        ) : <p className="text-sm text-status-neutral">Unit has no active or pending lease.</p>}
      </Section>

      <Section title="Term & economics">
        <div className="grid grid-cols-3 gap-4">
          <DateFact label="Commencement" v={a.commencement_date?.value} flags={flagsFor('commencement_date')} onChange={(v) => edit((d) => { d.commencement_date = setCited(v, d.commencement_date) })} />
          <DateFact label="Rent commencement" v={a.rent_commencement_date?.value} flags={flagsFor('rent_commencement_date')} onChange={(v) => edit((d) => { d.rent_commencement_date = setCited(v, d.rent_commencement_date) })} />
          <DateFact label="Expiration" v={a.expiration_date?.value} flags={flagsFor('expiration_date')} onChange={(v) => edit((d) => { d.expiration_date = setCited(v, d.expiration_date) })} />
          <Field label="Rent type">
            <Select value={a.rent_type?.value ?? ''} onChange={(e) => edit((d) => { d.rent_type = setCited(e.target.value || null, d.rent_type) })}>
              <option value="">— (NNN default)</option><option value="nnn">NNN</option><option value="gross">Gross</option><option value="modified_gross">Modified gross</option>
            </Select>
          </Field>
          <NumFact label="Security deposit ($)" v={a.security_deposit?.value} onChange={(v) => edit((d) => { d.security_deposit = setCited(v, d.security_deposit) })} />
          <NumFact label="Rentable SF" v={a.premises_rsf?.value} onChange={(v) => edit((d) => { d.premises_rsf = setCited(v, d.premises_rsf) })} />
          <NumFact label="Pro-rata share (fraction, 0.125 = 12.5%)" v={a.pro_rata_share?.value} onChange={(v) => edit((d) => { d.pro_rata_share = setCited(v, d.pro_rata_share) })} />
          <NumFact label="Base year" v={a.base_year?.value} onChange={(v) => edit((d) => { d.base_year = setCited(v === null ? null : Math.trunc(v), d.base_year) })} />
          <NumFact label="Expense stop ($/SF/yr)" v={a.expense_stop_psf_annual?.value} onChange={(v) => edit((d) => { d.expense_stop_psf_annual = setCited(v, d.expense_stop_psf_annual) })} />
        </div>
      </Section>

      <Section title={`Rent schedule (${a.rent_schedule.length})`}>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-status-neutral"><th>Start</th><th>End</th><th>As written</th><th>Period</th><th className="text-right">Monthly</th><th>Source</th></tr></thead>
          <tbody>
            {a.rent_schedule.map((r, i) => (
              <tr key={i} className={flagsFor(`rent_schedule[${i}]`).some((f) => f.severity === 'block') ? 'bg-status-danger/5' : ''}>
                <td><DateInput value={r.start} onChange={(e) => edit((d) => { d.rent_schedule[i].start = e.target.value })} /></td>
                <td><DateInput value={r.end} onChange={(e) => edit((d) => { d.rent_schedule[i].end = e.target.value })} /></td>
                <td><TextInput value={r.amount_as_written} placeholder="(derived)" onChange={(e) => edit((d) => { const row = d.rent_schedule[i]; row.amount_as_written = e.target.value; row.quote = REVIEWER_QUOTE(e.target.value); row.confidence = 1 })} /></td>
                <td>
                  <Select value={r.amount_period} onChange={(e) => edit((d) => { d.rent_schedule[i].amount_period = e.target.value as 'month' })}>
                    <option value="month">per month</option><option value="year">per year</option><option value="psf_year">per SF / yr</option>
                  </Select>
                </td>
                <td className="text-right font-mono">{dirty ? '…' : money(r.base_rent_monthly)}</td>
                <td className="text-xs text-status-neutral max-w-xs">p. {r.page} · “{r.quote}”</td>
              </tr>
            ))}
          </tbody>
        </table>
        {a.escalation && (
          <p className="text-sm mt-3">Escalation: <strong>{a.escalation.kind === 'cpi' ? 'CPI' : a.escalation.value_as_written}</strong> every {a.escalation.cadence_months} months from {a.escalation.first_adjustment_date} <span className="text-xs text-status-neutral">p. {a.escalation.page} · “{a.escalation.quote}”</span></p>
        )}
      </Section>

      <ListSection title="Concessions" items={a.concessions} onRemove={(i) => edit((d) => { d.concessions.splice(i, 1) })}
        render={(c) => <>{c.charge_type} · {c.kind.replace('_', ' ')} {c.value_as_written} · {c.period_start} → {c.period_end} · {c.reason} <Src p={c.page} q={c.quote} /></>} />
      <ListSection title="Recurring charges" items={a.recurring_charges} onRemove={(i) => edit((d) => { d.recurring_charges.splice(i, 1) })}
        render={(r) => <>{r.description} ({r.type}) · {r.amount_as_written} per {r.amount_period} = <span className="font-mono">{dirty ? '…' : money(r.amount_monthly)}</span>/mo · {r.effective_start} → {r.effective_end} <Src p={r.page} q={r.quote} /></>} />

      <Section title={`Rights & rules (${a.provisions.length})`}>
        {a.provisions.length === 0 ? <p className="text-sm text-status-neutral">None extracted.</p> : (
          <ul className="space-y-3">
            {a.provisions.map((p, i) => (
              <li key={i} className={`text-sm ${flagsFor(`provisions[${i}]`).some((f) => f.severity === 'block') ? 'bg-status-danger/5 p-2 rounded' : ''}`}>
                <div className="flex items-center gap-2 mb-1">
                  {/* Category and dates are editable (live run 2026-11-23: a renewal option came back with one end
                      of its exercise window, which blocked approval and could only be removed). */}
                  <Select aria-label="Provision category" className="w-56" value={p.category} onChange={(e) => edit((d) => { d.provisions[i].category = e.target.value })}>
                    {PROVISION_CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{provisionLabel(c)}</option>)}
                  </Select>
                  <button type="button" className="ml-auto text-xs text-status-danger" onClick={() => edit((d) => { d.provisions.splice(i, 1) })}>Remove</button>
                </div>
                <TextInput value={p.summary} onChange={(e) => edit((d) => { d.provisions[i].summary = e.target.value })} />
                <div className="grid grid-cols-3 gap-3 mt-2">
                  <Field label="Notice deadline"><DateInput value={p.notice_deadline ?? ''} onChange={(e) => edit((d) => { d.provisions[i].notice_deadline = e.target.value || null })} /></Field>
                  <Field label="Exercise window opens"><DateInput value={p.exercise_window_start ?? ''} onChange={(e) => edit((d) => { d.provisions[i].exercise_window_start = e.target.value || null })} /></Field>
                  <Field label="Exercise window closes"><DateInput value={p.exercise_window_end ?? ''} onChange={(e) => edit((d) => { d.provisions[i].exercise_window_end = e.target.value || null })} /></Field>
                </div>
                {flagsFor(`provisions[${i}]`).map((f, k) => <p key={k} className={`text-xs ${f.severity === 'block' ? 'text-status-danger' : 'text-status-warning'}`}>{f.message}</p>)}
                <Src p={p.page} q={p.quote} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Lease notes">
        <Textarea rows={10} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="text-xs text-status-neutral mt-1">Saved to the lease record. Provisions are also stored individually with notice dates as critical dates.</p>
      </Section>

      <Section title={`Confirm billing values (${confs.length - unconfirmed.length}/${confs.length})`}>
        {dirty && <p className="text-sm text-status-warning mb-2">You edited the abstract. Re-check to recompute amounts and the items to confirm.</p>}
        <ul className="space-y-2">
          {confs.map((cf) => {
            const k = confirmationKey(cf)
            return (
              <li key={k} className="text-sm flex gap-3">
                <input type="checkbox" className="mt-1" checked={checked.has(k)} disabled={dirty}
                  onChange={(e) => setChecked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(k); else n.delete(k); return n })} />
                <div>
                  <span className="font-mono text-xs mr-2">{cf.path}</span>
                  <strong>{cf.as_written}</strong> {cf.period}{cf.monthly !== null && <> → <span className="font-mono">{money(cf.monthly)}/mo</span></>}
                  {cf.start && <> · {cf.start} → {cf.end}</>}{cf.rsf !== null && <> · {cf.rsf.toLocaleString()} RSF</>}
                  {cf.first_adjustment_date && <> · from {cf.first_adjustment_date} every {cf.cadence_months} mo</>}
                  <Src p={cf.page} q={cf.quote} />
                </div>
              </li>
            )
          })}
        </ul>
      </Section>

      {problems.length > 0 && (
        <Section title="Cannot import yet: billing cannot bill this schedule">
          <p className="text-sm text-status-danger mb-3">
            Monthly billing bills this lease&apos;s own rent schedule, concessions and charges. In the months below it cannot
            (a gap, an overlap or conflicting concessions), so it would post nothing for them. Correct the schedule, then re-check.
          </p>
          <table className="w-full text-sm mb-3">
            <thead><tr className="text-left text-xs text-status-neutral"><th>Month</th><th>Problem</th></tr></thead>
            <tbody>
              {problems.map((p) => <tr key={`${p.period}-${p.code}`}><td>{p.period}</td><td>{p.detail}</td></tr>)}
            </tbody>
          </table>
        </Section>
      )}
      {error && <p className="text-sm text-status-danger mb-3">{error}</p>}
      <div className="flex gap-3">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        {dirty && <Button variant="gold" onClick={() => void recheck()} disabled={busy}>Re-check edits</Button>}
        <Button onClick={() => void approve()} disabled={!canApprove}>{busy ? 'Working…' : 'Approve & import'}</Button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card variant="default" className="p-5 mb-4">
      <h2 className="font-serif text-lg text-navy mb-3">{title}</h2>
      {children}
    </Card>
  )
}

function ListSection<T extends { page: number; quote: string }>({ title, items, render, onRemove }: { title: string; items: T[]; render: (x: T) => React.ReactNode; onRemove: (i: number) => void }) {
  return (
    <Section title={`${title} (${items.length})`}>
      {items.length === 0 ? <p className="text-sm text-status-neutral">None extracted.</p> : (
        <ul className="space-y-2">
          {items.map((x, i) => (
            <li key={i} className="text-sm flex gap-3">
              <div className="flex-1">{render(x)}</div>
              <button type="button" className="text-xs text-status-danger" onClick={() => onRemove(i)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Src({ p, q }: { p: number; q: string }) {
  return <div className="text-xs text-status-neutral mt-0.5">p. {p} · “{q}”</div>
}

function TextFact({ label, v, onChange }: { label: string; v: string | undefined; onChange: (v: string | null) => void }) {
  return <Field label={label}><TextInput value={v ?? ''} onChange={(e) => onChange(e.target.value || null)} /></Field>
}
function NumFact({ label, v, onChange }: { label: string; v: number | undefined; onChange: (v: number | null) => void }) {
  return <Field label={label}><NumberInput value={v ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} /></Field>
}
function DateFact({ label, v, flags, onChange }: { label: string; v: string | undefined; flags: Flag[]; onChange: (v: string | null) => void }) {
  return (
    <Field label={label}>
      <DateInput value={v ?? ''} onChange={(e) => onChange(e.target.value || null)} />
      {flags.map((f, i) => <p key={i} className={`text-xs ${f.severity === 'block' ? 'text-status-danger' : 'text-status-warning'}`}>{f.message}</p>)}
    </Field>
  )
}
