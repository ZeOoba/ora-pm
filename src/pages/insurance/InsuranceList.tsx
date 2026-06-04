import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDate, formatCurrency } from '../../lib/format'
import type { InsuranceCertificate, Tenant } from '../../types'

type CertRow = InsuranceCertificate & { tenants: Pick<Tenant, 'name'> }

export function InsuranceList() {
  const { data, isLoading } = useQuery({
    queryKey: ['insurance'],
    queryFn: () => api.get<{ data: CertRow[] }>('/insurance').then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  return (
    <div>
      <PageHeader
        title="Insurance Certificates"
        action={
          <Link
            to="/insurance/new"
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-1.5 rounded"
          >
            + Add Certificate
          </Link>
        }
      />
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Tenant', 'Policy Type', 'Carrier', 'Coverage', 'Expiration', 'Status'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data?.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No certificates on file.</td></tr>
            )}
            {data?.map(cert => (
              <tr key={cert.id} className={cert.status === 'expired' ? 'bg-red-50' : cert.status === 'expiring_soon' ? 'bg-orange-50' : ''}>
                <td className="px-4 py-3 font-medium">{cert.tenants?.name ?? '—'}</td>
                <td className="px-4 py-3 capitalize text-gray-600">{cert.policy_type.replace(/_/g, ' ')}</td>
                <td className="px-4 py-3 text-gray-500">{cert.carrier ?? '—'}</td>
                <td className="px-4 py-3">{formatCurrency(cert.coverage_amount)}</td>
                <td className="px-4 py-3">{formatDate(cert.expiration_date)}</td>
                <td className="px-4 py-3"><StatusBadge status={cert.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
