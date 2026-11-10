import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { EntityPage, SectionCard } from '../../components/EntityPage'
import { QueryState } from '../../components/QueryState'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Field } from '../../components/form/Field'
import { TextInput, DateInput, Select } from '../../components/form/inputs'
import { formatCurrency, formatDate, formatSF, formatPSF } from '../../lib/format'
import { CamTermsEditor } from './CamTermsEditor'
import type { Lease, Tenant, Unit, Property, LeaseAmendment, BrokerCommission, LeaseDocument, TenantNotice } from '../../types'

type LeaseDetail = Lease & {
  tenants: Tenant
  units: Unit & { properties: Property }
  lease_amendments: LeaseAmendment[]
  broker_commissions: BrokerCommission[]
  lease_documents: LeaseDocument[]
  tenant_notices: TenantNotice[]
}

interface AmendmentForm {
  effective_date: string
  description: string
  document_path: string
}

const EMPTY_AMENDMENT: AmendmentForm = {
  effective_date: '',
  description: '',
  document_path: '',
}

interface AmendmentErrors {
  effective_date?: string
  description?: string
}

function validateAmendment(f: AmendmentForm): AmendmentErrors {
  const e: AmendmentErrors = {}
  if (!f.effective_date) e.effective_date = 'Required'
  if (!f.description.trim()) e.description = 'Required'
  return e
}

function NoticesSection({ leaseId, notices }: { leaseId: string; notices: TenantNotice[] }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ notice_type: 'late_payment', sent_date: new Date().toISOString().slice(0,10), method: 'email', notes: '' })
  const noticeMutation = useSaveMutation<TenantNotice>({
    method: 'post',
    path: `/leases/${leaseId}/notices`,
    invalidate: [['lease', leaseId]],
    onSuccess: () => { setShowForm(false); setForm({ notice_type: 'late_payment', sent_date: new Date().toISOString().slice(0,10), method: 'email', notes: '' }) },
  })
  return (
    <SectionCard
      title={`Notices (${notices.length})`}
      action={<Button type="button" onClick={() => setShowForm(true)}>+ Log Notice</Button>}
    >
      <Sheet open={showForm} onOpenChange={setShowForm}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Log notice</SheetTitle>
            <SheetDescription>Record a notice sent to the tenant under this lease.</SheetDescription>
          </SheetHeader>
          <form onSubmit={e => { e.preventDefault(); noticeMutation.mutate(form) }} className="flex-1 overflow-y-auto px-4 pb-4">
            <Field label="Notice Type" htmlFor="notice-type">
              <Select id="notice-type" value={form.notice_type} onChange={e => setForm(f => ({...f, notice_type: e.target.value}))}>
                {['late_payment','lease_violation','eviction','renewal_offer','move_out_confirmation','cam_reconciliation','other'].map(t => (
                  <option key={t} value={t}>{t.replace(/_/g,' ')}</option>
                ))}
              </Select>
            </Field>
            <Field label="Method" htmlFor="notice-method">
              <Select id="notice-method" value={form.method} onChange={e => setForm(f => ({...f, method: e.target.value}))}>
                {['email','certified_mail','portal','hand_delivered'].map(m => (
                  <option key={m} value={m}>{m.replace(/_/g,' ')}</option>
                ))}
              </Select>
            </Field>
            <Field label="Sent Date" htmlFor="notice-date">
              <DateInput id="notice-date" value={form.sent_date} onChange={e => setForm(f => ({...f, sent_date: e.target.value}))} required />
            </Field>
            <Field label="Notes" htmlFor="notice-notes">
              <TextInput id="notice-notes" value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))} placeholder="Optional" />
            </Field>
            {noticeMutation.error && (
              <p role="alert" className="mb-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">
                {noticeMutation.error.message}
              </p>
            )}
            <div className="flex gap-3">
              <Button type="submit" disabled={noticeMutation.isPending}>{noticeMutation.isPending ? 'Saving…' : 'Save'}</Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
      {notices.length === 0 ? <p className="text-sm text-status-neutral">No notices logged.</p> : (
        <div className="divide-y divide-border">
          {notices.map(n => (
            <div key={n.id} className="flex justify-between py-2 text-sm">
              <div>
                <p className="font-medium capitalize text-navy">{n.notice_type.replace(/_/g,' ')}</p>
                <p className="text-xs text-status-neutral">{formatDate(n.sent_date)} · via {n.method.replace(/_/g,' ')}</p>
                {n.notes && <p className="mt-0.5 text-xs text-status-neutral/70">{n.notes}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

export function LeaseDetail() {
  const { id } = useParams<{ id: string }>()
  const [showAmendForm, setShowAmendForm] = useState(false)
  const [amendForm, setAmendForm] = useState<AmendmentForm>(EMPTY_AMENDMENT)
  const [amendErrors, setAmendErrors] = useState<AmendmentErrors>({})

  const query = useQuery({
    queryKey: ['lease', id],
    queryFn: () => api.get<{ data: LeaseDetail }>(`/leases/${id}`).then(r => r.data),
    enabled: !!id,
  })
  const data = query.data

  const amendMutation = useSaveMutation<LeaseAmendment>({
    method: 'post',
    path: `/leases/${id}/amendments`,
    invalidate: [['lease', id ?? '']],
    onSuccess: () => {
      setAmendForm(EMPTY_AMENDMENT)
      setAmendErrors({})
      setShowAmendForm(false)
    },
  })

  function setAmendField(field: keyof AmendmentForm, value: string) {
    setAmendForm(prev => ({ ...prev, [field]: value }))
    if (amendErrors[field as keyof AmendmentErrors]) {
      setAmendErrors(prev => ({ ...prev, [field]: undefined }))
    }
  }

  function handleAmendSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errs = validateAmendment(amendForm)
    if (Object.keys(errs).length > 0) {
      setAmendErrors(errs)
      return
    }
    amendMutation.mutate({
      effective_date: amendForm.effective_date,
      description: amendForm.description.trim(),
      document_path: amendForm.document_path.trim() || null,
      changes: {},
    })
  }

  function closeAmendForm() {
    setShowAmendForm(false)
    setAmendForm(EMPTY_AMENDMENT)
    setAmendErrors({})
  }

  const psf = data && data.units.sf > 0
    ? (data.base_rent_monthly * 12) / data.units.sf
    : null

  return (
    <QueryState query={query}>
      {!data ? (
        <EmptyState title="Lease not found" message="It may have been removed." />
      ) : (
        <EntityPage
          title={`${data.tenants.name} — ${data.units.suite}`}
          subtitle={data.units.properties.name}
          status={<StatusBadge status={data.status} />}
          actions={
            <Button asChild variant="ghost" className="border border-border">
              <Link to="/leases">← Back to leases</Link>
            </Button>
          }
          kpis={[
            { label: 'Base Rent', value: `${formatCurrency(data.base_rent_monthly)}/mo`, sub: psf != null ? `${formatPSF(psf)}/yr` : undefined },
            { label: 'CAM Estimate', value: `${formatCurrency(data.cam_estimate_monthly)}/mo` },
            { label: 'Lease Ends', value: formatDate(data.end_date), sub: `Started ${formatDate(data.start_date)}` },
            { label: 'Security Deposit', value: formatCurrency(data.security_deposit) },
          ]}
          timeline={[
            ...data.lease_amendments.map(a => ({ date: a.effective_date, label: `Amendment: ${a.description}` })),
            ...data.tenant_notices.map(n => ({
              date: n.sent_date,
              label: `Notice: ${n.notice_type.replace(/_/g, ' ')}`,
              detail: `via ${n.method.replace(/_/g, ' ')}`,
            })),
          ]}
          tabs={[
            {
              value: 'terms',
              label: 'Terms',
              content: (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <SectionCard title="Lease Terms" action={<CamTermsEditor leaseId={data.id} lease={data} />}>
                    <dl className="space-y-2">
                      <TermRow label="Status"><StatusBadge status={data.status} /></TermRow>
                      <TermRow label="Type">{data.rent_type.toUpperCase()}</TermRow>
                      <TermRow label="Start">{formatDate(data.start_date)}</TermRow>
                      <TermRow label="End">{formatDate(data.end_date)}</TermRow>
                      <TermRow label="Base Rent">{formatCurrency(data.base_rent_monthly)}/mo</TermRow>
                      <TermRow label="CAM Estimate">{formatCurrency(data.cam_estimate_monthly)}/mo</TermRow>
                      <TermRow label="Rent PSF">{psf != null ? formatPSF(psf) + '/yr' : '—'}</TermRow>
                      <TermRow label="Security Deposit">{formatCurrency(data.security_deposit)}</TermRow>
                      {data.ti_allowance != null && (
                        <TermRow label="TI Allowance">{formatCurrency(data.ti_allowance)}</TermRow>
                      )}
                      {data.expense_stop_amount != null && (
                        <TermRow label="Expense Stop">{formatCurrency(data.expense_stop_amount)}/SF/yr</TermRow>
                      )}
                      {data.proportionate_share_pct != null && (
                        <TermRow label="Proportionate Share">{(data.proportionate_share_pct * 100).toFixed(2)}% (stated in lease)</TermRow>
                      )}
                      {data.base_year != null && (
                        <TermRow label="Base Year">
                          {data.base_year}
                          {data.base_year_expense_amount != null ? ` · ${formatCurrency(data.base_year_expense_amount)} total` : ' · base-year amount not entered'}
                        </TermRow>
                      )}
                    </dl>
                  </SectionCard>
                  <SectionCard title="Property">
                    <dl className="space-y-2">
                      <TermRow label="Property">{data.units.properties.name}</TermRow>
                      <TermRow label="Suite">{data.units.suite}</TermRow>
                      <TermRow label="SF">{formatSF(data.units.sf)}</TermRow>
                    </dl>
                  </SectionCard>
                </div>
              ),
            },
            {
              value: 'amendments',
              label: 'Amendments',
              content: (
                <SectionCard
                  title={`Amendments (${data.lease_amendments.length})`}
                  action={<Button type="button" onClick={() => setShowAmendForm(true)}>+ Add Amendment</Button>}
                >
                  {data.lease_amendments.length === 0 ? (
                    <p className="text-sm text-status-neutral">No amendments yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {data.lease_amendments.map(a => (
                        <div key={a.id} className="flex justify-between border-b border-border pb-2 text-sm last:border-0">
                          <div>
                            <p className="font-medium text-navy">{a.description}</p>
                            <p className="text-xs text-status-neutral">Effective {formatDate(a.effective_date)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </SectionCard>
              ),
            },
            {
              value: 'notices',
              label: 'Notices',
              content: <NoticesSection leaseId={id!} notices={data.tenant_notices} />,
            },
            {
              value: 'documents',
              label: 'Documents',
              content: (
                <SectionCard title={`Documents (${data.lease_documents.length})`}>
                  {data.lease_documents.length === 0 ? (
                    <p className="text-sm text-status-neutral">No documents on file.</p>
                  ) : (
                    <div className="divide-y divide-border">
                      {data.lease_documents.map(doc => (
                        <div key={doc.id} className="flex items-center justify-between py-2">
                          <div>
                            <p className="text-sm font-medium text-navy">{doc.name}</p>
                            <p className="text-xs capitalize text-status-neutral">{doc.type.replace(/_/g, ' ')} · {formatDate(doc.uploaded_at)}</p>
                          </div>
                          <span className="rounded bg-muted px-2 py-0.5 text-xs text-status-neutral">{doc.storage_path.split('.').pop()?.toUpperCase() ?? 'FILE'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </SectionCard>
              ),
            },
            {
              value: 'commissions',
              label: 'Commissions',
              content: (
                <SectionCard title={`Broker Commissions (${data.broker_commissions.length})`}>
                  {data.broker_commissions.length === 0 ? (
                    <p className="text-sm text-status-neutral">No commissions recorded.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Broker</TableHead>
                            <TableHead>Company</TableHead>
                            <TableHead className="text-right">Rate</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Paid</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.broker_commissions.map(bc => (
                            <TableRow key={bc.id}>
                              <TableCell className="font-medium">{bc.broker_name}</TableCell>
                              <TableCell className="text-status-neutral">{bc.broker_company ?? '—'}</TableCell>
                              <TableCell className="text-right font-mono">{bc.commission_rate_pct != null ? `${bc.commission_rate_pct}%` : '—'}</TableCell>
                              <TableCell className="text-right font-mono font-medium">{bc.commission_amount != null ? formatCurrency(bc.commission_amount) : '—'}</TableCell>
                              <TableCell><StatusBadge status={bc.payment_status} /></TableCell>
                              <TableCell className="text-status-neutral">{formatDate(bc.payment_date)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </SectionCard>
              ),
            },
          ]}
        />
      )}

      <Sheet open={showAmendForm} onOpenChange={(open) => { if (!open) closeAmendForm() }}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New Amendment</SheetTitle>
            <SheetDescription>Record an amendment to this lease.</SheetDescription>
          </SheetHeader>
          <form onSubmit={handleAmendSubmit} noValidate className="flex-1 overflow-y-auto px-4 pb-4">
            <Field label="Effective Date" htmlFor="amend-date" required error={amendErrors.effective_date}>
              <DateInput
                id="amend-date"
                value={amendForm.effective_date}
                onChange={e => setAmendField('effective_date', e.target.value)}
              />
            </Field>
            <Field label="Description" htmlFor="amend-desc" required error={amendErrors.description}>
              <TextInput
                id="amend-desc"
                value={amendForm.description}
                onChange={e => setAmendField('description', e.target.value)}
                placeholder="e.g. Rent escalation to $4,800/mo"
              />
            </Field>
            <Field
              label="Document Path"
              htmlFor="amend-doc"
              hint="Storage path / URL"
            >
              <TextInput
                id="amend-doc"
                value={amendForm.document_path}
                onChange={e => setAmendField('document_path', e.target.value)}
                placeholder="Optional"
              />
            </Field>
            {amendMutation.error && (
              <p role="alert" className="mb-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">
                {amendMutation.error.message}
              </p>
            )}
            <div className="mt-1 flex items-center gap-3">
              <Button type="submit" disabled={amendMutation.isPending}>
                {amendMutation.isPending ? 'Saving…' : 'Add Amendment'}
              </Button>
              <Button type="button" variant="ghost" onClick={closeAmendForm}>Cancel</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </QueryState>
  )
}

function TermRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <dt className="text-status-neutral">{label}</dt>
      <dd className="text-right font-medium text-navy">{children}</dd>
    </div>
  )
}
