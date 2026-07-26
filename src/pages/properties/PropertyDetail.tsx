import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { TextInput, NumberInput, Select } from '../../components/form/inputs'
import { formatSF } from '../../lib/format'
import { UnitMatrix } from '../units/UnitMatrix'
import type { Property, Unit, UnitStatus } from '../../types'

type PropertyWithUnits = Property & { units: Unit[] }

interface UnitForm {
  suite: string
  floor: string
  sf: string
  status: UnitStatus
}

const EMPTY_UNIT: UnitForm = {
  suite: '',
  floor: '',
  sf: '',
  status: 'vacant',
}

interface UnitErrors {
  suite?: string
  sf?: string
}

function validateUnit(f: UnitForm): UnitErrors {
  const e: UnitErrors = {}
  if (!f.suite.trim()) e.suite = 'Required'
  if (!f.sf || isNaN(Number(f.sf)) || Number(f.sf) <= 0) e.sf = 'Required — enter a positive number'
  return e
}

export function PropertyDetail() {
  const { id } = useParams<{ id: string }>()
  const [showUnitForm, setShowUnitForm] = useState(false)
  const [unitForm, setUnitForm] = useState<UnitForm>(EMPTY_UNIT)
  const [unitErrors, setUnitErrors] = useState<UnitErrors>({})

  const { data, isLoading } = useQuery({
    queryKey: ['property', id],
    queryFn: () => api.get<{ data: PropertyWithUnits }>(`/properties/${id}`).then(r => r.data),
    enabled: !!id,
  })

  const unitMutation = useSaveMutation<Unit>({
    method: 'post',
    path: '/units',
    invalidate: [['units', id ?? ''], ['property', id ?? '']],
    onSuccess: () => {
      setUnitForm(EMPTY_UNIT)
      setShowUnitForm(false)
    },
  })

  function setUnitField(field: keyof UnitForm, value: string) {
    setUnitForm(prev => ({ ...prev, [field]: value }))
    if (unitErrors[field as keyof UnitErrors]) {
      setUnitErrors(prev => ({ ...prev, [field]: undefined }))
    }
  }

  function handleUnitSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errs = validateUnit(unitForm)
    if (Object.keys(errs).length > 0) {
      setUnitErrors(errs)
      return
    }
    unitMutation.mutate({
      property_id: id,
      suite: unitForm.suite.trim(),
      floor: unitForm.floor.trim() || null,
      sf: Number(unitForm.sf),
      status: unitForm.status,
    })
  }

  if (isLoading) return <p className="text-gray-500 p-4">Loading…</p>
  if (!data) return <p className="text-gray-500 p-4">Property not found.</p>

  const occupiedCount = data.units.filter(u => u.status === 'occupied').length

  return (
    <div>
      <PageHeader
        title={data.name}
        action={
          <Link
            to={`/properties/${id}/edit`}
            className="text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded"
          >
            Edit
          </Link>
        }
      />

      {/* Summary card */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Property Summary
        </h2>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2">
          <SummaryRow label="Address">
            {data.address}, {data.city}, {data.state} {data.zip}
          </SummaryRow>
          <SummaryRow label="Type">
            <span className="capitalize">{data.property_type}</span>
          </SummaryRow>
          <SummaryRow label="Total SF">{formatSF(data.total_sf)}</SummaryRow>
          <SummaryRow label="Entity LLC">{data.entity_llc ?? '—'}</SummaryRow>
          <SummaryRow label="Units">{data.units.length}</SummaryRow>
          <SummaryRow label="Occupied">{occupiedCount} of {data.units.length}</SummaryRow>
        </dl>
        {data.notes && (
          <p className="text-sm text-gray-500 mt-3 pt-3 border-t border-gray-100">{data.notes}</p>
        )}
      </div>

      {/* Units section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-800">Units</h2>
          {!showUnitForm && (
            <button
              type="button"
              onClick={() => setShowUnitForm(true)}
              className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded"
            >
              + Add Unit
            </button>
          )}
        </div>

        {showUnitForm && (
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Add Unit</h3>
            <form onSubmit={handleUnitSubmit} noValidate>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <Field label="Suite" htmlFor="unit-suite" required error={unitErrors.suite}>
                    <TextInput
                      id="unit-suite"
                      value={unitForm.suite}
                      onChange={e => setUnitField('suite', e.target.value)}
                      placeholder="101"
                    />
                  </Field>
                </div>
                <div>
                  <Field label="Floor" htmlFor="unit-floor">
                    <TextInput
                      id="unit-floor"
                      value={unitForm.floor}
                      onChange={e => setUnitField('floor', e.target.value)}
                      placeholder="1"
                    />
                  </Field>
                </div>
                <div>
                  <Field label="SF" htmlFor="unit-sf" required error={unitErrors.sf}>
                    <NumberInput
                      id="unit-sf"
                      value={unitForm.sf}
                      onChange={e => setUnitField('sf', e.target.value)}
                      placeholder="2400"
                      min={1}
                    />
                  </Field>
                </div>
                <div>
                  <Field label="Status" htmlFor="unit-status">
                    <Select
                      id="unit-status"
                      value={unitForm.status}
                      onChange={e => setUnitField('status', e.target.value)}
                    >
                      <option value="vacant">Vacant</option>
                      <option value="occupied">Occupied</option>
                      <option value="notice">Notice</option>
                      <option value="unavailable">Unavailable</option>
                    </Select>
                  </Field>
                </div>
              </div>
              {unitMutation.error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2 mb-3">
                  {unitMutation.error.message}
                </p>
              )}
              <div className="flex items-center gap-3 mt-1">
                <button
                  type="submit"
                  disabled={unitMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {unitMutation.isPending ? 'Saving…' : 'Add Unit'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowUnitForm(false); setUnitForm(EMPTY_UNIT); setUnitErrors({}) }}
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        <UnitMatrix propertyId={id!} />
      </div>
    </div>
  )
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start text-sm">
      <dt className="text-gray-500 w-28 shrink-0">{label}</dt>
      <dd className="font-medium text-gray-900">{children}</dd>
    </div>
  )
}
