import { useState } from 'react'
import { useParams, Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { EntityPage, DetailList, DetailRow, SectionCard } from '../../components/EntityPage'
import { QueryState } from '../../components/QueryState'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Field } from '../../components/form/Field'
import { TextInput, NumberInput, Select } from '../../components/form/inputs'
import { formatCurrency, formatDate, formatSF } from '../../lib/format'
import { UnitMatrix } from '../units/UnitMatrix'
import { leaseRowsOf } from './property-leases'
import type { Property, RentRollRow, Unit, UnitStatus } from '../../types'

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

  const query = useQuery({
    queryKey: ['property', id],
    queryFn: () => api.get<{ data: PropertyWithUnits }>(`/properties/${id}`).then(r => r.data),
    enabled: !!id,
  })
  const data = query.data

  // Leases tab: the per-property rent-roll report (same pattern as CAMList); only rows with a lease_id are leases.
  const rentRoll = useQuery({
    queryKey: ['rent-roll', id],
    queryFn: () => api.get<{ data: RentRollRow[] }>(`/reports/rent-roll?property_id=${id}`).then(r => r.data),
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

  function closeUnitForm() {
    setShowUnitForm(false)
    setUnitForm(EMPTY_UNIT)
    setUnitErrors({})
  }

  const units = data?.units ?? []
  const occupiedCount = units.filter(u => u.status === 'occupied').length
  const leaseRows = leaseRowsOf(rentRoll.data)

  return (
    <QueryState query={query}>
      {!data ? (
        <EmptyState title="Property not found" message="It may have been removed." />
      ) : (
        <EntityPage
          title={data.name}
          subtitle={`${data.address}, ${data.city}, ${data.state} ${data.zip}`}
          status={<span className="text-sm capitalize text-status-neutral">{data.property_type}</span>}
          actions={
            <Button asChild variant="ghost" className="border border-border">
              <Link to={`/properties/${id}/edit`}>Edit</Link>
            </Button>
          }
          kpis={[
            { label: 'Total SF', value: formatSF(data.total_sf) },
            { label: 'Units', value: units.length },
            { label: 'Occupied', value: `${occupiedCount} of ${units.length}` },
            { label: 'Entity LLC', value: data.entity_llc ?? '—' },
          ]}
          tabs={[
            {
              value: 'overview',
              label: 'Overview',
              content: (
                <SectionCard title="Property Summary">
                  <DetailList>
                    <DetailRow label="Address">
                      {data.address}, {data.city}, {data.state} {data.zip}
                    </DetailRow>
                    <DetailRow label="Type">
                      <span className="capitalize">{data.property_type}</span>
                    </DetailRow>
                    <DetailRow label="Total SF">{formatSF(data.total_sf)}</DetailRow>
                    <DetailRow label="Entity LLC">{data.entity_llc ?? '—'}</DetailRow>
                    <DetailRow label="Units">{units.length}</DetailRow>
                    <DetailRow label="Occupied">{occupiedCount} of {units.length}</DetailRow>
                  </DetailList>
                  {data.notes && (
                    <p className="mt-3 border-t border-border pt-3 text-sm text-status-neutral">{data.notes}</p>
                  )}
                </SectionCard>
              ),
            },
            {
              value: 'units',
              label: 'Units',
              content: (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="font-display text-base text-navy">Units</h2>
                    <Button type="button" onClick={() => setShowUnitForm(true)}>+ Add Unit</Button>
                  </div>
                  <UnitMatrix propertyId={id!} />
                </div>
              ),
            },
            {
              value: 'leases',
              label: 'Leases',
              content: (
                <QueryState
                  query={rentRoll}
                  isEmpty={() => leaseRows.length === 0}
                  empty={<EmptyState title="No active leases" message="No unit at this property has an active lease." />}
                >
                  <div className="overflow-x-auto rounded-lg border border-border bg-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Suite</TableHead>
                          <TableHead>Tenant</TableHead>
                          <TableHead className="text-right">Monthly rent</TableHead>
                          <TableHead>End date</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {leaseRows.map(r => (
                          <TableRow key={r.lease_id}>
                            <TableCell className="font-medium">
                              <Link to={`/leases/${r.lease_id}`} className="text-navy underline-offset-2 hover:underline">{r.suite}</Link>
                            </TableCell>
                            <TableCell>{r.tenant_name ?? '—'}</TableCell>
                            <TableCell className="text-right font-mono">{formatCurrency(r.total_monthly)}</TableCell>
                            <TableCell>{formatDate(r.end_date)}</TableCell>
                            <TableCell>{r.lease_status ? <StatusBadge status={r.lease_status} /> : '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </QueryState>
              ),
            },
          ]}
        />
      )}

      <Sheet open={showUnitForm} onOpenChange={(open) => { if (!open) closeUnitForm() }}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Add Unit</SheetTitle>
            <SheetDescription>Create a new unit at this property.</SheetDescription>
          </SheetHeader>
          <form onSubmit={handleUnitSubmit} noValidate className="flex-1 overflow-y-auto px-4 pb-4">
            <Field label="Suite" htmlFor="unit-suite" required error={unitErrors.suite}>
              <TextInput
                id="unit-suite"
                value={unitForm.suite}
                onChange={e => setUnitField('suite', e.target.value)}
                placeholder="101"
              />
            </Field>
            <Field label="Floor" htmlFor="unit-floor">
              <TextInput
                id="unit-floor"
                value={unitForm.floor}
                onChange={e => setUnitField('floor', e.target.value)}
                placeholder="1"
              />
            </Field>
            <Field label="SF" htmlFor="unit-sf" required error={unitErrors.sf}>
              <NumberInput
                id="unit-sf"
                value={unitForm.sf}
                onChange={e => setUnitField('sf', e.target.value)}
                placeholder="2400"
                min={1}
              />
            </Field>
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
            {unitMutation.error && (
              <p role="alert" className="mb-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">
                {unitMutation.error.message}
              </p>
            )}
            <div className="mt-1 flex items-center gap-3">
              <Button type="submit" disabled={unitMutation.isPending}>
                {unitMutation.isPending ? 'Saving…' : 'Add Unit'}
              </Button>
              <Button type="button" variant="ghost" onClick={closeUnitForm}>Cancel</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </QueryState>
  )
}
