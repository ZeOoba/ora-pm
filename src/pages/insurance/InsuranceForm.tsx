import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { NumberInput, DateInput, Select, TextInput } from '../../components/form/inputs'
import { FormActions } from '../../components/form/FormActions'
import type { Tenant, InsuranceCertificate, InsurancePolicyType } from '../../types'

interface FormState {
  tenant_id: string
  policy_type: InsurancePolicyType | ''
  carrier: string
  policy_number: string
  coverage_amount: string
  effective_date: string
  expiration_date: string
}

const EMPTY: FormState = {
  tenant_id: '',
  policy_type: '',
  carrier: '',
  policy_number: '',
  coverage_amount: '',
  effective_date: '',
  expiration_date: '',
}

interface FormErrors {
  tenant_id?: string
  policy_type?: string
  effective_date?: string
  expiration_date?: string
}

function validate(f: FormState): FormErrors {
  const e: FormErrors = {}
  if (!f.tenant_id) e.tenant_id = 'Required'
  if (!f.policy_type) e.policy_type = 'Required'
  if (!f.effective_date) e.effective_date = 'Required'
  if (!f.expiration_date) {
    e.expiration_date = 'Required'
  } else if (f.effective_date && f.expiration_date <= f.effective_date) {
    e.expiration_date = 'Must be after effective date'
  }
  return e
}

export function InsuranceForm() {
  const navigate = useNavigate()

  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<FormErrors>({})

  const { data: tenants, isLoading: tenantsLoading } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.listAll<Tenant>('/tenants'),
  })

  const mutation = useSaveMutation<InsuranceCertificate>({
    method: 'post',
    path: '/insurance',
    invalidate: [['insurance']],
    onSuccess: () => navigate('/insurance'),
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
      policy_type: form.policy_type as InsurancePolicyType,
      carrier: form.carrier.trim() || null,
      policy_number: form.policy_number.trim() || null,
      coverage_amount: form.coverage_amount === '' ? null : Number(form.coverage_amount),
      effective_date: form.effective_date,
      expiration_date: form.expiration_date,
    })
  }

  if (tenantsLoading) return <p className="text-muted-foreground p-4">Loading…</p>

  return (
    <div>
      <PageHeader title="New Insurance Certificate" />
      <div className="max-w-lg">
        <form onSubmit={handleSubmit} noValidate>
          <Field label="Tenant" htmlFor="tenant_id" required error={errors.tenant_id}>
            <Select
              id="tenant_id"
              value={form.tenant_id}
              onChange={e => set('tenant_id', e.target.value)}
            >
              <option value="">— Select tenant —</option>
              {(tenants ?? []).map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Policy Type" htmlFor="policy_type" required error={errors.policy_type}>
            <Select
              id="policy_type"
              value={form.policy_type}
              onChange={e => set('policy_type', e.target.value)}
            >
              <option value="">— Select type —</option>
              <option value="general_liability">General Liability</option>
              <option value="property">Property</option>
              <option value="workers_comp">Workers Comp</option>
              <option value="umbrella">Umbrella</option>
              <option value="other">Other</option>
            </Select>
          </Field>

          <Field label="Carrier" htmlFor="carrier">
            <TextInput
              id="carrier"
              value={form.carrier}
              onChange={e => set('carrier', e.target.value)}
              placeholder="e.g. Travelers"
            />
          </Field>

          <Field label="Policy Number" htmlFor="policy_number">
            <TextInput
              id="policy_number"
              value={form.policy_number}
              onChange={e => set('policy_number', e.target.value)}
              placeholder="e.g. GL-12345678"
            />
          </Field>

          <Field label="Coverage Amount" htmlFor="coverage_amount" hint="Leave blank if unknown">
            <NumberInput
              id="coverage_amount"
              value={form.coverage_amount}
              onChange={e => set('coverage_amount', e.target.value)}
              placeholder="e.g. 1000000"
              min={0}
            />
          </Field>

          <Field label="Effective Date" htmlFor="effective_date" required error={errors.effective_date}>
            <DateInput
              id="effective_date"
              value={form.effective_date}
              onChange={e => set('effective_date', e.target.value)}
            />
          </Field>

          <Field label="Expiration Date" htmlFor="expiration_date" required error={errors.expiration_date}>
            <DateInput
              id="expiration_date"
              value={form.expiration_date}
              onChange={e => set('expiration_date', e.target.value)}
            />
          </Field>

          <FormActions
            cancelTo="/insurance"
            pending={mutation.isPending}
            error={mutation.error?.message}
          />
        </form>
      </div>
    </div>
  )
}
