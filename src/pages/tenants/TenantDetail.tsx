import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { EntityPage, DetailList, DetailRow, SectionCard } from '../../components/EntityPage'
import { QueryState } from '../../components/QueryState'
import { StatusBadge } from '../../components/StatusBadge'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Field } from '../../components/form/Field'
import { TextInput, DateInput, Select, Textarea } from '../../components/form/inputs'
import { formatCurrency, formatDate } from '../../lib/format'
import type { Tenant, Lease, InsuranceCertificate, Unit, Property, CorrespondenceEntry } from '../../types'
import { TenantPortalAdmin } from '../admin/TenantPortalAdmin'
import { useSaveMutation } from '../../lib/mutations'

type LeaseWithJoins = Lease & {
  units?: Unit & { properties?: Property }
}

type TenantWithJoins = Tenant & {
  leases?: LeaseWithJoins[]
  insurance_certificates?: InsuranceCertificate[]
  correspondence_log?: CorrespondenceEntry[]
}

function CorrespondenceSection({ tenantId, correspondence }: { tenantId: string; correspondence: CorrespondenceEntry[] }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    direction: 'outbound', contact_date: new Date().toISOString().slice(0,10),
    subject: '', summary: '', method: 'phone',
  })
  const mutation = useSaveMutation<CorrespondenceEntry>({
    method: 'post',
    path: `/tenants/${tenantId}/correspondence`,
    invalidate: [['tenant', tenantId]],
    onSuccess: () => { setShowForm(false); setForm({ direction: 'outbound', contact_date: new Date().toISOString().slice(0,10), subject: '', summary: '', method: 'phone' }) },
  })
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-base text-navy">Correspondence Log</h2>
        <Button type="button" onClick={() => setShowForm(true)}>+ Log Entry</Button>
      </div>
      <Sheet open={showForm} onOpenChange={setShowForm}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Log correspondence</SheetTitle>
            <SheetDescription>Record a call, email, letter or meeting with this tenant.</SheetDescription>
          </SheetHeader>
          <form onSubmit={e => { e.preventDefault(); mutation.mutate(form) }} className="flex-1 overflow-y-auto px-4 pb-4">
            <Field label="Direction" htmlFor="corr-direction">
              <Select id="corr-direction" value={form.direction} onChange={e => setForm(f => ({...f, direction: e.target.value}))}>
                <option value="outbound">Outbound</option>
                <option value="inbound">Inbound</option>
              </Select>
            </Field>
            <Field label="Method" htmlFor="corr-method">
              <Select id="corr-method" value={form.method} onChange={e => setForm(f => ({...f, method: e.target.value}))}>
                {['email','phone','letter','portal','in_person'].map(m => (
                  <option key={m} value={m}>{m.replace(/_/g,' ')}</option>
                ))}
              </Select>
            </Field>
            <Field label="Date" htmlFor="corr-date">
              <DateInput id="corr-date" value={form.contact_date} onChange={e => setForm(f => ({...f, contact_date: e.target.value}))} required />
            </Field>
            <Field label="Subject" htmlFor="corr-subject">
              <TextInput id="corr-subject" value={form.subject} onChange={e => setForm(f => ({...f, subject: e.target.value}))} required placeholder="e.g. Late payment follow-up" />
            </Field>
            <Field label="Summary" htmlFor="corr-summary">
              <Textarea id="corr-summary" value={form.summary} onChange={e => setForm(f => ({...f, summary: e.target.value}))} required rows={2} placeholder="Brief notes on the interaction" />
            </Field>
            {mutation.error && (
              <p role="alert" className="mb-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">
                {mutation.error.message}
              </p>
            )}
            <div className="flex gap-3">
              <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save'}</Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {['Date', 'Direction', 'Method', 'Subject', 'Summary'].map(h => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {correspondence.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-status-neutral">No correspondence on file.</TableCell></TableRow>
            )}
            {correspondence.map(entry => (
              <TableRow key={entry.id}>
                <TableCell className="text-status-neutral">{formatDate(entry.contact_date)}</TableCell>
                <TableCell>
                  <Badge tone={entry.direction === 'inbound' ? 'pending' : 'neutral'}>{entry.direction}</Badge>
                </TableCell>
                <TableCell className="capitalize text-status-neutral">{entry.method.replace(/_/g,' ')}</TableCell>
                <TableCell className="font-medium text-navy">{entry.subject}</TableCell>
                <TableCell className="max-w-xs truncate text-status-neutral">{entry.summary}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function TenantDetail() {
  const { id } = useParams<{ id: string }>()

  const query = useQuery({
    queryKey: ['tenant', id],
    queryFn: () =>
      api.get<{ data: TenantWithJoins }>(`/tenants/${id}`).then(r => r.data),
    enabled: !!id,
  })
  const data = query.data

  return (
    <QueryState query={query}>
      {!data ? (
        <EmptyState title="Tenant not found" message="It may have been removed." />
      ) : (
        <TenantView data={data} id={id} />
      )}
    </QueryState>
  )
}

function TenantView({ data, id }: { data: TenantWithJoins; id: string | undefined }) {
  const leases = data.leases ?? []
  const certs = data.insurance_certificates ?? []
  const correspondence = data.correspondence_log ?? []

  const activeLeases = leases.filter(l => l.status === 'active')
  const monthlyRent = activeLeases.reduce((s, l) => s + (l.base_rent_monthly ?? 0), 0)
  const insuranceIssues = certs.filter(c => c.status === 'expired' || c.status === 'expiring_soon').length
  const hasPortal = !!data.auth_user_id

  return (
    <EntityPage
      title={data.name}
      subtitle={data.contact_name ?? undefined}
      status={hasPortal ? <Badge tone="active">Portal access</Badge> : undefined}
      actions={
        <Button asChild variant="ghost" className="border border-border">
          <Link to={`/tenants/${id}/edit`}>Edit</Link>
        </Button>
      }
      kpis={[
        { label: 'Active Leases', value: activeLeases.length, sub: `${leases.length} total` },
        { label: 'Base Rent', value: formatCurrency(monthlyRent), sub: 'Active leases, per month' },
        { label: 'Insurance', value: insuranceIssues === 0 ? 'OK' : insuranceIssues, sub: insuranceIssues === 0 ? `${certs.length} on file` : 'Expired or expiring', warn: insuranceIssues > 0 },
        { label: 'Portal', value: hasPortal ? 'Active' : 'None' },
      ]}
      timeline={correspondence.map(c => ({
        date: c.contact_date,
        label: c.subject,
        detail: `${c.direction} · ${c.method.replace(/_/g, ' ')}`,
      }))}
      timelineTitle="Recent correspondence"
      tabs={[
        {
          value: 'overview',
          label: 'Overview',
          content: (
            <SectionCard title="Contact">
              <DetailList>
                <DetailRow label="Name">{data.contact_name ?? '—'}</DetailRow>
                <DetailRow label="Email">
                  {data.contact_email ? (
                    <a href={`mailto:${data.contact_email}`} className="text-navy underline-offset-2 hover:underline">
                      {data.contact_email}
                    </a>
                  ) : '—'}
                </DetailRow>
                <DetailRow label="Phone">{data.contact_phone ?? '—'}</DetailRow>
              </DetailList>
              {data.notes && (
                <p className="mt-3 border-t border-border pt-3 text-sm text-status-neutral">{data.notes}</p>
              )}
            </SectionCard>
          ),
        },
        {
          value: 'leases',
          label: 'Leases',
          content: (
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    {['Suite', 'Property', 'Base Rent', 'End Date', 'Status'].map(h => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leases.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="py-8 text-center text-status-neutral">No leases on file.</TableCell></TableRow>
                  )}
                  {leases.map(lease => (
                    <TableRow key={lease.id}>
                      <TableCell className="font-medium">
                        <Link to={`/leases/${lease.id}`} className="text-navy underline-offset-2 hover:underline">
                          {lease.units?.suite ?? '—'}
                        </Link>
                      </TableCell>
                      <TableCell className="text-status-neutral">{lease.units?.properties?.name ?? '—'}</TableCell>
                      <TableCell className="font-mono">{formatCurrency(lease.base_rent_monthly)}/mo</TableCell>
                      <TableCell className="text-status-neutral">{formatDate(lease.end_date)}</TableCell>
                      <TableCell><StatusBadge status={lease.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ),
        },
        {
          value: 'insurance',
          label: 'Insurance',
          content: (
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    {['Policy Type', 'Carrier', 'Coverage', 'Expiration', 'Status'].map(h => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {certs.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="py-8 text-center text-status-neutral">No certificates on file.</TableCell></TableRow>
                  )}
                  {certs.map(cert => (
                    <TableRow
                      key={cert.id}
                      className={
                        cert.status === 'expired'
                          ? 'bg-status-danger/5'
                          : cert.status === 'expiring_soon'
                          ? 'bg-status-warning/5'
                          : ''
                      }
                    >
                      <TableCell className="capitalize">{cert.policy_type.replace(/_/g, ' ')}</TableCell>
                      <TableCell className="text-status-neutral">{cert.carrier ?? '—'}</TableCell>
                      <TableCell className="font-mono">{formatCurrency(cert.coverage_amount)}</TableCell>
                      <TableCell className="text-status-neutral">{formatDate(cert.expiration_date)}</TableCell>
                      <TableCell><StatusBadge status={cert.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ),
        },
        {
          value: 'correspondence',
          label: 'Correspondence',
          content: <CorrespondenceSection tenantId={data.id} correspondence={correspondence} />,
        },
        {
          value: 'portal',
          label: 'Portal',
          content: <TenantPortalAdmin tenant={data} />,
        },
      ]}
    />
  )
}
