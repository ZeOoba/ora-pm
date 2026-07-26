import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
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
    <div className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-800">Correspondence Log</h2>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700">+ Log Entry</button>
        )}
      </div>
      {showForm && (
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(form) }} className="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Direction</label>
            <select value={form.direction} onChange={e => setForm(f => ({...f, direction: e.target.value}))} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
            <select value={form.method} onChange={e => setForm(f => ({...f, method: e.target.value}))} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
              {['email','phone','letter','portal','in_person'].map(m => (
                <option key={m} value={m}>{m.replace(/_/g,' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
            <input type="date" value={form.contact_date} onChange={e => setForm(f => ({...f, contact_date: e.target.value}))} required className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
            <input type="text" value={form.subject} onChange={e => setForm(f => ({...f, subject: e.target.value}))} required placeholder="e.g. Late payment follow-up" className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Summary</label>
            <textarea value={form.summary} onChange={e => setForm(f => ({...f, summary: e.target.value}))} required rows={2} placeholder="Brief notes on the interaction" className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div className="col-span-2 flex gap-3">
            <button type="submit" disabled={mutation.isPending} className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm hover:bg-blue-700 disabled:opacity-50">{mutation.isPending ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={() => setShowForm(false)} className="text-sm text-gray-600">Cancel</button>
          </div>
        </form>
      )}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Date', 'Direction', 'Method', 'Subject', 'Summary'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {correspondence.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No correspondence on file.</td></tr>
            )}
            {correspondence.map(entry => (
              <tr key={entry.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-600">{formatDate(entry.contact_date)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${entry.direction === 'inbound' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                    {entry.direction}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600 capitalize">{entry.method.replace(/_/g,' ')}</td>
                <td className="px-4 py-3 font-medium text-gray-900">{entry.subject}</td>
                <td className="px-4 py-3 text-gray-500 max-w-xs truncate">{entry.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function TenantDetail() {
  const { id } = useParams<{ id: string }>()

  const { data, isLoading } = useQuery({
    queryKey: ['tenant', id],
    queryFn: () =>
      api.get<{ data: TenantWithJoins }>(`/tenants/${id}`).then(r => r.data),
    enabled: !!id,
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>
  if (!data) return <p className="text-gray-500 p-4">Tenant not found.</p>

  const leases = data.leases ?? []
  const certs = data.insurance_certificates ?? []

  return (
    <div>
      <PageHeader
        title={data.name}
        action={
          <Link
            to={`/tenants/${id}/edit`}
            className="text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded"
          >
            Edit
          </Link>
        }
      />

      {/* Contact card */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Contact
        </h2>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2">
          <ContactRow label="Name">{data.contact_name ?? '—'}</ContactRow>
          <ContactRow label="Email">
            {data.contact_email ? (
              <a href={`mailto:${data.contact_email}`} className="text-blue-600 hover:underline">
                {data.contact_email}
              </a>
            ) : '—'}
          </ContactRow>
          <ContactRow label="Phone">{data.contact_phone ?? '—'}</ContactRow>
        </dl>
        {data.notes && (
          <p className="text-sm text-gray-500 mt-3 pt-3 border-t border-gray-100">{data.notes}</p>
        )}
      </div>

      {/* Tenant Portal admin */}
      <div className="mb-6">
        <TenantPortalAdmin tenant={data} />
      </div>

      {/* Leases section */}
      <div className="mb-6">
        <h2 className="text-base font-semibold text-gray-800 mb-3">Leases</h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {['Suite', 'Property', 'Base Rent', 'End Date', 'Status'].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {leases.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No leases on file.
                  </td>
                </tr>
              )}
              {leases.map(lease => (
                <tr key={lease.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-blue-600">
                    <Link to={`/leases/${lease.id}`}>
                      {lease.units?.suite ?? '—'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {lease.units?.properties?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {formatCurrency(lease.base_rent_monthly)}/mo
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {formatDate(lease.end_date)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={lease.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Insurance Certificates section */}
      <div>
        <h2 className="text-base font-semibold text-gray-800 mb-3">Insurance Certificates</h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {['Policy Type', 'Carrier', 'Coverage', 'Expiration', 'Status'].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {certs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No certificates on file.
                  </td>
                </tr>
              )}
              {certs.map(cert => (
                <tr
                  key={cert.id}
                  className={
                    cert.status === 'expired'
                      ? 'bg-red-50'
                      : cert.status === 'expiring_soon'
                      ? 'bg-orange-50'
                      : ''
                  }
                >
                  <td className="px-4 py-3 capitalize text-gray-700">
                    {cert.policy_type.replace(/_/g, ' ')}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{cert.carrier ?? '—'}</td>
                  <td className="px-4 py-3">{formatCurrency(cert.coverage_amount)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(cert.expiration_date)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={cert.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <CorrespondenceSection tenantId={data.id} correspondence={data.correspondence_log ?? []} />
    </div>
  )
}

function ContactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start text-sm">
      <dt className="text-gray-500 w-20 shrink-0">{label}</dt>
      <dd className="font-medium text-gray-900">{children}</dd>
    </div>
  )
}
