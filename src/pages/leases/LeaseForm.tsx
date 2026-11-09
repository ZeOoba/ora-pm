import { useState } from 'react'
import { useNavigate, Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { NumberInput, DateInput, Select, Textarea } from '../../components/form/inputs'
import { FormActions } from '../../components/form/FormActions'
import type { Lease, LeaseStatus, RentType, Tenant, Unit, Property } from '../../types'

interface FormState {
  tenant_id: string
  unit_id: string
  start_date: string
  end_date: string
  status: LeaseStatus
  rent_type: RentType
  base_rent_monthly: string
  cam_estimate_monthly: string
  security_deposit: string
  expense_stop_amount: string
  /** Percent as typed / as the lease prints it (12.5 = 12.5%); sent as a fraction. */
  proportionate_share_percent: string
  base_year: string
  base_year_expense_amount: string
  ti_allowance: string
  notes: string
}

const EMPTY: FormState = {
  tenant_id: '',
  unit_id: '',
  start_date: '',
  end_date: '',
  status: 'active',
  rent_type: 'nnn',
  base_rent_monthly: '',
  cam_estimate_monthly: '0',
  security_deposit: '0',
  expense_stop_amount: '',
  proportionate_share_percent: '',
  base_year: '',
  base_year_expense_amount: '',
  ti_allowance: '',
  notes: '',
}

interface FormErrors {
  tenant_id?: string
  unit_id?: string
  start_date?: string
  end_date?: string
  base_rent_monthly?: string
  cam_estimate_monthly?: string
  security_deposit?: string
  proportionate_share_percent?: string
  base_year?: string
  base_year_expense_amount?: string
}

function validate(f: FormState): FormErrors {
  const e: FormErrors = {}
  if (!f.tenant_id) e.tenant_id = 'Required'
  if (!f.unit_id) e.unit_id = 'Required'
  if (!f.start_date) e.start_date = 'Required'
  if (!f.end_date) {
    e.end_date = 'Required'
  } else if (f.start_date && f.end_date <= f.start_date) {
    e.end_date = 'End date must be after start date'
  }
  if (f.base_rent_monthly === '') {
    e.base_rent_monthly = 'Required'
  } else if (Number(f.base_rent_monthly) < 0) {
    e.base_rent_monthly = 'Must be ≥ 0'
  }
  if (f.cam_estimate_monthly !== '' && Number(f.cam_estimate_monthly) < 0) {
    e.cam_estimate_monthly = 'Must be ≥ 0'
  }
  if (f.security_deposit !== '' && Number(f.security_deposit) < 0) {
    e.security_deposit = 'Must be ≥ 0'
  }
  if (f.proportionate_share_percent !== '') {
    const pct = Number(f.proportionate_share_percent)
    if (!(Number.isFinite(pct) && pct > 0 && pct <= 100)) e.proportionate_share_percent = 'Enter a percent above 0 and at most 100'
  }
  if (f.base_year !== '') {
    const y = Number(f.base_year)
    if (!(Number.isInteger(y) && y >= 1900 && y <= 2200)) e.base_year = 'Enter a calendar year, e.g. 2026'
  }
  if (f.base_year_expense_amount !== '') {
    const amt = Number(f.base_year_expense_amount)
    if (!(Number.isFinite(amt) && amt >= 0)) e.base_year_expense_amount = 'Must be ≥ 0'
    else if (f.base_year === '') e.base_year = 'Required when a base-year amount is entered'
  }
  return e
}

export function LeaseForm({
  initialValues,
  confidence,
}: {
  initialValues?: Partial<Record<keyof FormState, string>>
  confidence?: Record<string, number>
} = {}) {
  const navigate = useNavigate()

  const [form, setForm] = useState<FormState>({ ...EMPTY, ...(initialValues ?? {}) } as FormState)
  const [errors, setErrors] = useState<FormErrors>({})

  // Auto-extracted fields below this confidence get a "verify" hint in the form.
  const lowConf = (k: string) =>
    confidence !== undefined && confidence[k] !== undefined && confidence[k] < 0.85

  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.listAll<Tenant>('/tenants'),
  })

  const unitsQ = useQuery({
    queryKey: ['units', 'all'],
    queryFn: () => api.listAll<Unit>('/units'),
  })

  const propsQ = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.listAll<Property>('/properties'),
  })

  const mutation = useSaveMutation<Lease>({
    method: 'post',
    path: '/leases',
    invalidate: [['leases', 'active'], ['leases'], ['renewals']],
    onSuccess: (saved) => {
      navigate('/leases/' + saved.id)
    },
  })

  function set(field: keyof FormState, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field as keyof FormErrors]) {
      setErrors(prev => ({ ...prev, [field]: undefined }))
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errs = validate(form)
    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      return
    }
    mutation.mutate({
      tenant_id: form.tenant_id,
      unit_id: form.unit_id,
      start_date: form.start_date,
      end_date: form.end_date,
      status: form.status,
      rent_type: form.rent_type,
      base_rent_monthly: Number(form.base_rent_monthly),
      cam_estimate_monthly: form.cam_estimate_monthly === '' ? 0 : Number(form.cam_estimate_monthly),
      security_deposit: form.security_deposit === '' ? 0 : Number(form.security_deposit),
      expense_stop_amount: form.expense_stop_amount === '' ? null : Number(form.expense_stop_amount),
      // Typed as a percent (12.5), stored as a fraction (0.125): leases.proportionate_share_pct.
      proportionate_share_pct: form.proportionate_share_percent === '' ? null : Number(form.proportionate_share_percent) / 100,
      base_year: form.base_year === '' ? null : Number(form.base_year),
      base_year_expense_amount: form.base_year_expense_amount === '' ? null : Number(form.base_year_expense_amount),
      ti_allowance: form.ti_allowance === '' ? null : Number(form.ti_allowance),
      notes: form.notes.trim() || null,
    })
  }

  const isLoading = tenantsQ.isLoading || unitsQ.isLoading || propsQ.isLoading

  if (isLoading) return <p className="text-muted-foreground p-4">Loading…</p>

  const tenants = tenantsQ.data ?? []
  const units = unitsQ.data ?? []
  const propName = new Map((propsQ.data ?? []).map(p => [p.id, p.name]))

  const sortedUnits = [...units].sort((a, b) => {
    const la = `${propName.get(a.property_id) ?? '—'} · ${a.suite}`
    const lb = `${propName.get(b.property_id) ?? '—'} · ${b.suite}`
    return la.localeCompare(lb)
  })

  if (tenants.length === 0 || units.length === 0) {
    return (
      <div>
        <PageHeader title="New Lease" />
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 max-w-lg">
          <p className="text-amber-800 font-medium mb-2">
            You need at least one tenant and one unit before creating a lease.
          </p>
          <ul className="text-sm text-amber-700 space-y-1 list-disc list-inside">
            {tenants.length === 0 && (
              <li>
                <Link to="/tenants/new" className="underline hover:text-amber-900">
                  Add a tenant
                </Link>
              </li>
            )}
            {units.length === 0 && (
              <li>
                <Link to="/properties" className="underline hover:text-amber-900">
                  Add a unit via a property
                </Link>
              </li>
            )}
          </ul>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="New Lease" />
      <div className="max-w-2xl">
        <form onSubmit={handleSubmit} noValidate>

          {/* Tenant & Unit — full width */}
          <Field label="Tenant" htmlFor="tenant_id" required error={errors.tenant_id}>
            <Select
              id="tenant_id"
              value={form.tenant_id}
              onChange={e => set('tenant_id', e.target.value)}
            >
              <option value="">Select tenant…</option>
              {tenants.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="Unit" htmlFor="unit_id" required error={errors.unit_id}>
            <Select
              id="unit_id"
              value={form.unit_id}
              onChange={e => set('unit_id', e.target.value)}
            >
              <option value="">Select unit…</option>
              {sortedUnits.map(u => (
                <option key={u.id} value={u.id}>
                  {propName.get(u.property_id) ?? '—'} · {u.suite} ({u.sf.toLocaleString()} SF)
                </option>
              ))}
            </Select>
          </Field>

          {/* Dates row */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start Date" htmlFor="start_date" required error={errors.start_date} hint={lowConf('start_date') ? '⚠ Verify — auto-extracted' : undefined}>
              <DateInput
                id="start_date"
                value={form.start_date}
                onChange={e => set('start_date', e.target.value)}
              />
            </Field>
            <Field label="End Date" htmlFor="end_date" required error={errors.end_date} hint={lowConf('end_date') ? '⚠ Verify — auto-extracted' : undefined}>
              <DateInput
                id="end_date"
                value={form.end_date}
                onChange={e => set('end_date', e.target.value)}
              />
            </Field>
          </div>

          {/* Status & Rent Type row */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Status" htmlFor="status" required>
              <Select
                id="status"
                value={form.status}
                onChange={e => set('status', e.target.value)}
              >
                <option value="active">Active</option>
                <option value="pending">Pending</option>
                <option value="expired">Expired</option>
                <option value="terminated">Terminated</option>
              </Select>
            </Field>
            <Field label="Rent Type" htmlFor="rent_type" required>
              <Select
                id="rent_type"
                value={form.rent_type}
                onChange={e => set('rent_type', e.target.value)}
              >
                <option value="nnn">NNN</option>
                <option value="gross">Gross</option>
                <option value="modified_gross">Modified Gross</option>
              </Select>
            </Field>
          </div>

          {/* Money fields — 2 columns */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Base Rent ($/mo)" htmlFor="base_rent_monthly" required error={errors.base_rent_monthly} hint={lowConf('base_rent_monthly') ? '⚠ Verify — auto-extracted' : undefined}>
              <NumberInput
                id="base_rent_monthly"
                value={form.base_rent_monthly}
                onChange={e => set('base_rent_monthly', e.target.value)}
                placeholder="e.g. 4500"
                min={0}
              />
            </Field>
            <Field label="CAM Estimate ($/mo)" htmlFor="cam_estimate_monthly" error={errors.cam_estimate_monthly} hint={lowConf('cam_estimate_monthly') ? '⚠ Verify — auto-extracted' : undefined}>
              <NumberInput
                id="cam_estimate_monthly"
                value={form.cam_estimate_monthly}
                onChange={e => set('cam_estimate_monthly', e.target.value)}
                placeholder="0"
                min={0}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Security Deposit ($)" htmlFor="security_deposit" error={errors.security_deposit}>
              <NumberInput
                id="security_deposit"
                value={form.security_deposit}
                onChange={e => set('security_deposit', e.target.value)}
                placeholder="0"
                min={0}
              />
            </Field>
            <Field
              label="Expense Stop ($/SF/yr)"
              htmlFor="expense_stop_amount"
              hint="For gross / modified-gross leases"
            >
              <NumberInput
                id="expense_stop_amount"
                value={form.expense_stop_amount}
                onChange={e => set('expense_stop_amount', e.target.value)}
                placeholder="Optional"
                min={0}
              />
            </Field>
          </div>

          {/* CAM Proportionate Share and base year (0019; CAM ruling 2026-11-08) */}
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Proportionate Share (%)"
              htmlFor="proportionate_share_percent"
              error={errors.proportionate_share_percent}
              hint={
                form.proportionate_share_percent !== '' && Number(form.proportionate_share_percent) > 0 && Number(form.proportionate_share_percent) < 1
                  ? '⚠ Under 1% — enter a percent (12.5 for 12.5%), not a fraction (0.125)'
                  : lowConf('proportionate_share_percent') ? '⚠ Verify — auto-extracted' : 'As stated in the lease, e.g. 12.5. Blank = premises SF / property CAM denominator.'
              }
            >
              <NumberInput
                id="proportionate_share_percent"
                value={form.proportionate_share_percent}
                onChange={e => set('proportionate_share_percent', e.target.value)}
                placeholder="Optional"
                min={0}
                max={100}
                step="any"
              />
            </Field>
            <Field
              label="Base Year (calendar year)"
              htmlFor="base_year"
              error={errors.base_year}
              hint={lowConf('base_year') ? '⚠ Verify — auto-extracted' : 'Only for base-year leases: tenant pays its share of the increase'}
            >
              <NumberInput
                id="base_year"
                value={form.base_year}
                onChange={e => set('base_year', e.target.value)}
                placeholder="Optional"
                min={1900}
                max={2200}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Base-Year Expenses ($ total, whole pool)"
              htmlFor="base_year_expense_amount"
              error={errors.base_year_expense_amount}
              hint={lowConf('base_year_expense_amount') ? '⚠ Verify — auto-extracted' : 'Base year recoverable Operating Costs + Taxes, total dollars (not $/SF)'}
            >
              <NumberInput
                id="base_year_expense_amount"
                value={form.base_year_expense_amount}
                onChange={e => set('base_year_expense_amount', e.target.value)}
                placeholder="Optional"
                min={0}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="TI Allowance ($)" htmlFor="ti_allowance">
              <NumberInput
                id="ti_allowance"
                value={form.ti_allowance}
                onChange={e => set('ti_allowance', e.target.value)}
                placeholder="Optional"
                min={0}
              />
            </Field>
          </div>

          {/* Notes — full width */}
          <Field label="Notes" htmlFor="notes">
            <Textarea
              id="notes"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any additional notes…"
            />
          </Field>

          <FormActions
            submitLabel="Create Lease"
            cancelTo="/leases"
            pending={mutation.isPending}
            error={mutation.error?.message}
          />
        </form>
      </div>
    </div>
  )
}
