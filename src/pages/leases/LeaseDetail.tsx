import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { formatCurrency, formatDate, formatSF, formatPSF } from '../../lib/format'
import type { Lease, Tenant, Unit, Property } from '../../types'

type LeaseDetail = Lease & {
  tenants: Tenant
  units: Unit & { properties: Property }
}

export function LeaseDetail() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading } = useQuery({
    queryKey: ['lease', id],
    queryFn: () => api.get<{ data: LeaseDetail }>(`/leases/${id}`).then(r => r.data),
    enabled: !!id,
  })

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>
  if (!data) return <p className="text-gray-500 p-4">Lease not found.</p>

  const psf = data.units.sf > 0
    ? (data.base_rent_monthly * 12) / data.units.sf
    : null

  return (
    <div>
      <PageHeader
        title={`${data.tenants.name} — ${data.units.suite}`}
        action={
          <Link to="/leases" className="text-sm text-gray-500 hover:text-gray-700">
            ← Back to leases
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-6">
        <Section title="Lease Terms">
          <Row label="Status"><StatusBadge status={data.status} /></Row>
          <Row label="Type">{data.rent_type.toUpperCase()}</Row>
          <Row label="Start">{formatDate(data.start_date)}</Row>
          <Row label="End">{formatDate(data.end_date)}</Row>
          <Row label="Base Rent">{formatCurrency(data.base_rent_monthly)}/mo</Row>
          <Row label="CAM Estimate">{formatCurrency(data.cam_estimate_monthly)}/mo</Row>
          <Row label="Rent PSF">{psf != null ? formatPSF(psf) + '/yr' : '—'}</Row>
          <Row label="Security Deposit">{formatCurrency(data.security_deposit)}</Row>
          {data.ti_allowance != null && (
            <Row label="TI Allowance">{formatCurrency(data.ti_allowance)}</Row>
          )}
          {data.expense_stop_amount != null && (
            <Row label="Expense Stop">{formatCurrency(data.expense_stop_amount)}/SF</Row>
          )}
        </Section>
        <Section title="Property">
          <Row label="Property">{data.units.properties.name}</Row>
          <Row label="Suite">{data.units.suite}</Row>
          <Row label="SF">{formatSF(data.units.sf)}</Row>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">{title}</h2>
      <dl className="space-y-2">{children}</dl>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900 text-right">{children}</dd>
    </div>
  )
}
