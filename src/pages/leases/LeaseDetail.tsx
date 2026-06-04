import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { Field } from '../../components/form/Field'
import { TextInput, DateInput } from '../../components/form/inputs'
import { formatCurrency, formatDate, formatSF, formatPSF } from '../../lib/format'
import type { Lease, Tenant, Unit, Property, LeaseAmendment } from '../../types'

type LeaseDetail = Lease & {
  tenants: Tenant
  units: Unit & { properties: Property }
  lease_amendments: LeaseAmendment[]
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

export function LeaseDetail() {
  const { id } = useParams<{ id: string }>()
  const [showAmendForm, setShowAmendForm] = useState(false)
  const [amendForm, setAmendForm] = useState<AmendmentForm>(EMPTY_AMENDMENT)
  const [amendErrors, setAmendErrors] = useState<AmendmentErrors>({})

  const { data, isLoading } = useQuery({
    queryKey: ['lease', id],
    queryFn: () => api.get<{ data: LeaseDetail }>(`/leases/${id}`).then(r => r.data),
    enabled: !!id,
  })

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

        {/* Amendments — always render header + Add button */}
        <div className="col-span-2 bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-400 uppercase">
              Amendments ({data.lease_amendments.length})
            </h2>
            {!showAmendForm && (
              <button
                type="button"
                onClick={() => setShowAmendForm(true)}
                className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded"
              >
                + Add Amendment
              </button>
            )}
          </div>

          {showAmendForm && (
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">New Amendment</h3>
              <form onSubmit={handleAmendSubmit} noValidate>
                <div className="grid grid-cols-2 gap-4">
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
                </div>
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
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2 mb-3">
                    {amendMutation.error.message}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-1">
                  <button
                    type="submit"
                    disabled={amendMutation.isPending}
                    className="bg-blue-600 hover:bg-blue-700 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {amendMutation.isPending ? 'Saving…' : 'Add Amendment'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAmendForm(false)
                      setAmendForm(EMPTY_AMENDMENT)
                      setAmendErrors({})
                    }}
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {data.lease_amendments.length === 0 ? (
            <p className="text-sm text-gray-400">No amendments yet.</p>
          ) : (
            <div className="space-y-2">
              {data.lease_amendments.map(a => (
                <div key={a.id} className="flex justify-between text-sm border-b border-gray-100 pb-2 last:border-0">
                  <div>
                    <p className="font-medium text-gray-900">{a.description}</p>
                    <p className="text-gray-400 text-xs">Effective {formatDate(a.effective_date)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
