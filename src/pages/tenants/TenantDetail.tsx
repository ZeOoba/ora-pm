import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { formatCurrency, formatDate } from '../../lib/format'
import type { Tenant, Lease, InsuranceCertificate, Unit, Property } from '../../types'
import { TenantPortalAdmin } from '../admin/TenantPortalAdmin'

type LeaseWithJoins = Lease & {
  units?: Unit & { properties?: Property }
}

type TenantWithJoins = Tenant & {
  leases?: LeaseWithJoins[]
  insurance_certificates?: InsuranceCertificate[]
  correspondence_log?: unknown[]
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
