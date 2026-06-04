import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import type { Tenant } from '../../types'

export function TenantsList() {
  const { data, isLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.get<{ data: Tenant[] }>('/tenants').then(r => r.data),
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  return (
    <div>
      <PageHeader title="Tenants" />
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {['Company', 'Contact', 'Email', 'Phone'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data?.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No tenants yet.</td></tr>
            )}
            {data?.map(t => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-blue-600">
                  <Link to={`/tenants/${t.id}`}>{t.name}</Link>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{t.contact_name ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{t.contact_email ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{t.contact_phone ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
