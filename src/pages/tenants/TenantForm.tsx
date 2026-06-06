import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { TextInput, Textarea } from '../../components/form/inputs'
import { FormActions } from '../../components/form/FormActions'
import type { Tenant } from '../../types'

interface FormState {
  name: string
  contact_name: string
  contact_email: string
  contact_phone: string
  notes: string
}

const EMPTY: FormState = {
  name: '',
  contact_name: '',
  contact_email: '',
  contact_phone: '',
  notes: '',
}

interface FormErrors {
  name?: string
  contact_email?: string
}

function validate(f: FormState): FormErrors {
  const e: FormErrors = {}
  if (!f.name.trim()) e.name = 'Required'
  if (f.contact_email.trim() && !f.contact_email.includes('@')) {
    e.contact_email = 'Must be a valid email address'
  }
  return e
}

export function TenantForm() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const isEdit = !!id

  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<FormErrors>({})
  const [seeded, setSeeded] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['tenant', id],
    queryFn: () => api.get<{ data: Tenant }>(`/tenants/${id}`).then(r => r.data),
    enabled: isEdit,
  })

  useEffect(() => {
    if (data && !seeded) {
      setForm({
        name: data.name ?? '',
        contact_name: data.contact_name ?? '',
        contact_email: data.contact_email ?? '',
        contact_phone: data.contact_phone ?? '',
        notes: data.notes ?? '',
      })
      setSeeded(true)
    }
  }, [data, seeded])

  const mutation = useSaveMutation<Tenant>({
    method: isEdit ? 'put' : 'post',
    path: isEdit ? `/tenants/${id}` : '/tenants',
    invalidate: [['tenants'], ['tenant', id ?? '']],
    onSuccess: (saved) => {
      navigate(`/tenants/${id ?? saved.id}`)
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
      contact_name: form.contact_name.trim() || null,
      contact_email: form.contact_email.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      notes: form.notes.trim() || null,
    })
  }

  if (isEdit && isLoading) return <p className="text-gray-500 p-4">Loading…</p>

  return (
    <div>
      <PageHeader title={isEdit ? 'Edit Tenant' : 'New Tenant'} />
      <div className="max-w-lg">
        <form onSubmit={handleSubmit} noValidate>
          <Field label="Company Name" htmlFor="name" required error={errors.name}>
            <TextInput
              id="name"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Acme Logistics LLC"
            />
          </Field>

          <Field label="Contact Name" htmlFor="contact_name">
            <TextInput
              id="contact_name"
              value={form.contact_name}
              onChange={e => set('contact_name', e.target.value)}
              placeholder="e.g. Jane Smith"
            />
          </Field>

          <Field label="Contact Email" htmlFor="contact_email" error={errors.contact_email}>
            <TextInput
              id="contact_email"
              type="email"
              value={form.contact_email}
              onChange={e => set('contact_email', e.target.value)}
              placeholder="e.g. jane@acme.com"
            />
          </Field>

          <Field label="Contact Phone" htmlFor="contact_phone">
            <TextInput
              id="contact_phone"
              value={form.contact_phone}
              onChange={e => set('contact_phone', e.target.value)}
              placeholder="e.g. (614) 555-1234"
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
            cancelTo={isEdit ? `/tenants/${id}` : '/tenants'}
            pending={mutation.isPending}
            error={mutation.error?.message}
          />
        </form>
      </div>
    </div>
  )
}
