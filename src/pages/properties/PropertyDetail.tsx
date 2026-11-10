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
import { StackingPlan } from '../portfolio/StackingPlan'
import { stackingPlan, walt } from '../portfolio/portfolio-derive'
import { compactMoney, computeVitals, pastDue, type ArAgingLeaseRow } from '../today/today-queue'
import type { AgingTotals } from '../ar/ar-aging-view'
import type { MonthlyIncomeStatementResponse } from '../../lib/report-types'
import type { QueryLike } from '../../components/query-state'
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

  // Server-aged balances for this property's leases (stacking-plan "past due" state).
  const arAging = useQuery({
    queryKey: ['ar-aging', 'buckets', id],
    queryFn: () => api.get<{ data: ArAgingLeaseRow[]; totals: AgingTotals }>(`/reports/ar-aging?property_id=${id}`),
    enabled: !!id,
  })
  // Trailing 12 complete months, billed basis (server/lib/financial-report.ts — not a GL).
  const through = lastCompleteMonth()
  const t12 = useQuery({
    queryKey: ['income-12mo', id, through],
    queryFn: () => api.get<MonthlyIncomeStatementResponse>(`/reports/income-statement-12mo?through=${through}&property_ids=${id}`),
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
  const today = new Date().toISOString().slice(0, 10)
  const rr = rentRoll.data ?? []
  const arRows = arAging.data?.data ?? []
  const vitals = computeVitals(rr, arRows, today)
  const propWalt = walt(rr, today)
  const pastDueTotal = arRows.reduce((sum, a) => sum + pastDue(a.buckets), 0)
  const suites = stackingPlan(rr, arRows, today)
  const balanceByLease = new Map(arRows.map(a => [a.lease_id, a.balance]))

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
            { label: 'Leased', value: vitals.sfOccupancyPct == null ? '—' : `${vitals.sfOccupancyPct.toFixed(1)}%`, sub: `${formatSF(vitals.leasedSf)} of ${formatSF(vitals.totalSf)}` },
            { label: 'Units occupied', value: `${occupiedCount} of ${units.length}` },
            { label: 'ABR', value: compactMoney(vitals.abr), sub: 'Base rent × 12' },
            { label: 'WALT', value: propWalt == null ? '—' : `${propWalt.toFixed(1)} yr` },
            { label: 'Past due', value: compactMoney(pastDueTotal), warn: pastDueTotal > 0 },
            { label: 'Entity LLC', value: data.entity_llc ?? '—' },
          ]}
          tabs={[
            {
              value: 'overview',
              label: 'Overview',
              content: (
                <div className="flex flex-wrap items-start gap-7">
                  <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-3.5">
                    <h2 className="font-display text-2xl text-navy">Stacking plan</h2>
                    <QueryState query={[rentRoll, arAging]} isEmpty={() => suites.length === 0}
                      empty={<EmptyState title="No units" message="Add units to see the stacking plan." />}>
                      <StackingPlan suites={suites} />
                      <div className="mt-2 overflow-x-auto rounded-xl border border-border bg-card">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Suite</TableHead>
                              <TableHead>Tenant</TableHead>
                              <TableHead className="text-right">SF</TableHead>
                              <TableHead className="text-right">Rent/SF</TableHead>
                              <TableHead className="text-right">Monthly</TableHead>
                              <TableHead>Expires</TableHead>
                              <TableHead className="text-right">Balance</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {[...rr].sort((a, b) => a.suite.localeCompare(b.suite, 'en-US', { numeric: true })).map(r => {
                              const bal = r.lease_id ? balanceByLease.get(r.lease_id) ?? 0 : 0
                              return (
                                <TableRow key={r.unit_id}>
                                  <TableCell className="font-mono">{r.suite}</TableCell>
                                  <TableCell>
                                    {r.tenant_id ? (
                                      <Link to={`/tenants/${r.tenant_id}`} className="text-navy underline-offset-2 hover:underline">{r.tenant_name}</Link>
                                    ) : <span className="capitalize text-muted-foreground">{r.unit_status}</span>}
                                  </TableCell>
                                  <TableCell className="text-right font-mono">{(r.sf ?? 0).toLocaleString('en-US')}</TableCell>
                                  <TableCell className="text-right font-mono">{r.rent_psf_annual != null ? `$${r.rent_psf_annual.toFixed(2)}` : '—'}</TableCell>
                                  <TableCell className="text-right font-mono">{formatCurrency(r.total_monthly)}</TableCell>
                                  <TableCell>
                                    {r.lease_id ? <Link to={`/leases/${r.lease_id}`} className="underline-offset-2 hover:underline">{formatDate(r.end_date)}</Link> : '—'}
                                  </TableCell>
                                  <TableCell className={bal > 0 ? 'text-right font-mono text-status-danger' : 'text-right font-mono text-muted-foreground'}>
                                    {r.lease_id ? formatCurrency(bal) : '—'}
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </QueryState>
                  </div>
                  <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
                    <T12Card query={t12} />
                <SectionCard title="Property Summary">
                  <DetailList>
                    <DetailRow label="Address">
                      {data.address}, {data.city}, {data.state} {data.zip}
                    </DetailRow>
                    <DetailRow label="Type">
                      <span className="capitalize">{data.property_type}</span>
                    </DetailRow>
                    <DetailRow label="Total SF">{formatSF(data.total_sf)}</DetailRow>
                    <DetailRow label="CAM Denominator (RSF)">{data.cam_denominator_rsf != null ? formatSF(data.cam_denominator_rsf) : '— (not entered)'}</DetailRow>
                    <DetailRow label="Entity LLC">{data.entity_llc ?? '—'}</DetailRow>
                    <DetailRow label="Units">{units.length}</DetailRow>
                    <DetailRow label="Occupied">{occupiedCount} of {units.length}</DetailRow>
                  </DetailList>
                  {data.notes && (
                    <p className="mt-3 border-t border-border pt-3 text-sm text-status-neutral">{data.notes}</p>
                  )}
                </SectionCard>
                  </div>
                </div>
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

function lastCompleteMonth(today: Date = new Date()): string {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
}

/** Trailing 12 complete months, billed basis (charges posted and expenses recorded; not a GL). */
function T12Card({ query }: { query: QueryLike & { data?: MonthlyIncomeStatementResponse } }) {
  const r = query.data
  const t = r?.total
  const rows: [string, number, boolean][] = t
    ? [
        ['Total income', t.total_income, false],
        ['Operating expenses', -t.total_operating_expense, false],
        ['Net operating income', t.noi, true],
        ['Capital', -t.total_capital, false],
      ]
    : []
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-xl text-navy">Trailing 12 months</span>
        {r && r.months.length > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground">{r.months[0]} – {r.months[r.months.length - 1]}</span>
        )}
      </div>
      <QueryState query={query}>
        {rows.map(([label, v, strong]) => (
          <div key={label} className={strong ? 'flex justify-between border-t border-border/60 py-1.5 text-[13px] font-semibold' : 'flex justify-between border-t border-border/60 py-1.5 text-[13px]'}>
            <span>{label}</span>
            <span className="font-mono">{formatCurrency(v)}</span>
          </div>
        ))}
        <p className="pt-1 text-[11px] text-muted-foreground">Billed basis: charges posted and expenses recorded. Not a general ledger.</p>
      </QueryState>
    </div>
  )
}
