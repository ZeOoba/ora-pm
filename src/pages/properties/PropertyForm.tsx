import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { TextInput, NumberInput, Select, Textarea } from '../../components/form/inputs'
import { FormActions } from '../../components/form/FormActions'
import type { Property, PropertyType } from '../../types'

interface FormState {
  name: string
  address: string
  city: string
  state: string
  zip: string
  property_type: PropertyType
  total_sf: string
  entity_llc: string
  notes: string
}

const EMPTY: FormState = {
  name: '',
  address: '',
  city: '',
  state: '',
  zip: '',
  property_type: 'industrial',
  total_sf: '',
  entity_llc: '',
  notes: '',
}

interface FormErrors {
  name?: string
  address?: string
  city?: string
  state?: string
  zip?: string
  property_type?: string
}

function validate(f: FormState): FormErrors {
  const e: FormErrors = {}
  if (!f.name.trim()) e.name = 'Required'
  if (!f.address.trim()) e.address = 'Required'
  if (!f.city.trim()) e.city = 'Required'
  if (!f.state.trim()) e.state = 'Required'
  else if (f.state.trim().length !== 2) e.state = 'Must be 2-character state code'
  // ZIP is optional (0005): the system of record carries no ZIP for most properties.
  if (f.zip.trim() && !/^\d{5}(-\d{4})?$/.test(f.zip.trim())) e.zip = 'Must be 12345 or 12345-6789'
  if (!f.property_type) e.property_type = 'Required'
  return e
}

export function PropertyForm() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const isEdit = !!id

  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<FormErrors>({})
  const [seeded, setSeeded] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['property', id],
    queryFn: () => api.get<{ data: Property & { units: unknown[] } }>(`/properties/${id}`).then(r => r.data),
    enabled: isEdit,
  })

  useEffect(() => {
    if (data && !seeded) {
      setForm({
        name: data.name ?? '',
        address: data.address ?? '',
        city: data.city ?? '',
        state: data.state ?? '',
        zip: data.zip ?? '',
        property_type: data.property_type ?? 'industrial',
        total_sf: data.total_sf != null ? String(data.total_sf) : '',
        entity_llc: data.entity_llc ?? '',
        notes: data.notes ?? '',
      })
      setSeeded(true)
    }
  }, [data, seeded])

  const mutation = useSaveMutation<Property>({
    method: isEdit ? 'put' : 'post',
    path: isEdit ? `/properties/${id}` : '/properties',
    invalidate: [['properties'], ['property', id ?? '']],
    onSuccess: (saved) => {
      navigate('/properties/' + saved.id)
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
      name: form.name.trim(),
      address: form.address.trim(),
      city: form.city.trim(),
      state: form.state.trim().toUpperCase(),
      zip: form.zip.trim() || null,
      property_type: form.property_type,
      total_sf: form.total_sf === '' ? null : Number(form.total_sf),
      entity_llc: form.entity_llc.trim() || null,
      notes: form.notes.trim() || null,
    })
  }

  if (isEdit && isLoading) return <p className="text-muted-foreground p-4">Loading…</p>

  return (
    <div>
      <PageHeader title={isEdit ? 'Edit Property' : 'New Property'} />
      <div className="max-w-lg">
        <form onSubmit={handleSubmit} noValidate>
          <Field label="Property Name" htmlFor="name" required error={errors.name}>
            <TextInput
              id="name"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Westside Industrial Park"
            />
          </Field>

          <Field label="Street Address" htmlFor="address" required error={errors.address}>
            <TextInput
              id="address"
              value={form.address}
              onChange={e => set('address', e.target.value)}
              placeholder="e.g. 123 Main St"
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1">
              <Field label="City" htmlFor="city" required error={errors.city}>
                <TextInput
                  id="city"
                  value={form.city}
                  onChange={e => set('city', e.target.value)}
                  placeholder="Columbus"
                />
              </Field>
            </div>
            <div className="col-span-1">
              <Field label="State" htmlFor="state" required error={errors.state}>
                <TextInput
                  id="state"
                  value={form.state}
                  onChange={e => set('state', e.target.value)}
                  placeholder="OH"
                  maxLength={2}
                />
              </Field>
            </div>
            <div className="col-span-1">
              <Field label="ZIP" htmlFor="zip" error={errors.zip}>
                <TextInput
                  id="zip"
                  value={form.zip}
                  onChange={e => set('zip', e.target.value)}
                  placeholder="43215"
                />
              </Field>
            </div>
          </div>

          <Field label="Property Type" htmlFor="property_type" required error={errors.property_type}>
            <Select
              id="property_type"
              value={form.property_type}
              onChange={e => set('property_type', e.target.value)}
            >
              <option value="industrial">Industrial</option>
              <option value="commercial">Commercial</option>
              <option value="retail">Retail</option>
              <option value="multifamily">Multifamily</option>
              <option value="office">Office</option>
              <option value="other">Other</option>
            </Select>
          </Field>

          <Field label="Total SF" htmlFor="total_sf" hint="Leave blank if unknown">
            <NumberInput
              id="total_sf"
              value={form.total_sf}
              onChange={e => set('total_sf', e.target.value)}
              placeholder="e.g. 24000"
              min={0}
            />
          </Field>

          <Field label="Entity / LLC" htmlFor="entity_llc" hint="Holding entity name">
            <TextInput
              id="entity_llc"
              value={form.entity_llc}
              onChange={e => set('entity_llc', e.target.value)}
              placeholder="e.g. ORA Westside LLC"
            />
          </Field>

          <Field label="Notes" htmlFor="notes">
            <Textarea
              id="notes"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any additional notes…"
            />
          </Field>

          <FormActions
            cancelTo={isEdit ? `/properties/${id}` : '/properties'}
            pending={mutation.isPending}
            error={mutation.error?.message}
          />
        </form>
      </div>
    </div>
  )
}
