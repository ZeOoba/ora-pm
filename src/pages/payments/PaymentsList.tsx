import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { TextInput, NumberInput, DateInput, Select, Textarea } from '../../components/form/inputs'
import { formatCurrency, formatDate } from '../../lib/format'
import type { Payment, Lease, PaymentMethod } from '../../types'

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentRow = Payment & {
  leases: { tenant_id: string; tenants: { name: string } | null } | null
}

type LeaseWithJoins = Lease & {
  tenants: { name: string } | null
  units: {
    suite: string
    sf: number
    properties: { name: string } | null
  } | null
}

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
  lease_id: string
  payment_date: string
  amount: string
  method: PaymentMethod
  check_number: string
  notes: string
}

const today = new Date().toISOString().slice(0, 10)

// OI-082: one dedupe token per form session, sent as idempotency_key. A
// double-click, a React Query retry, or a resubmit after a network timeout
// resends the SAME value, so migration 0015's payments_idempotency_key_uniq
// rejects the second row (the API answers 409 "already recorded") instead of
// a duplicate payment silently understating the tenant's ar_ledger balance.
// Regenerated whenever the form is reset, so a genuine second payment — even
// one with identical lease/date/amount — gets its own token.
const newIdempotencyKey = () => `manual:${crypto.randomUUID()}`

const EMPTY: FormState = {
  lease_id: '',
  payment_date: today,
  amount: '',
  method: 'check',
  check_number: '',
  notes: '',
}

interface FormErrors {
  lease_id?: string
  payment_date?: string
  amount?: string
}

function validate(f: FormState): FormErrors {
  const e: FormErrors = {}
  if (!f.lease_id) e.lease_id = 'Required'
  if (!f.payment_date) e.payment_date = 'Required'
  if (f.amount === '') {
    e.amount = 'Required'
  } else if (Number(f.amount) <= 0) {
    e.amount = 'Must be > 0'
  }
  return e
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PaymentsList() {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<FormErrors>({})
  const [idempotencyKey, setIdempotencyKey] = useState<string>(newIdempotencyKey)

  // Payment history
  const paymentsQ = useQuery({
    queryKey: ['payments'],
    queryFn: () => api.get<{ data: PaymentRow[] }>('/payments').then(r => r.data),
  })

  // Active leases for dropdown
  const leasesQ = useQuery({
    queryKey: ['leases', 'active'],
    queryFn: () =>
      api.get<{ data: LeaseWithJoins[] }>('/leases?status=active').then(r => r.data),
  })

  const mutation = useSaveMutation<Payment>({
    method: 'post',
    path: '/payments',
    invalidate: [['payments'], ['ar-aging']],
    onSuccess: () => {
      setForm(EMPTY)
      setIdempotencyKey(newIdempotencyKey())
      setShowForm(false)
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
      lease_id: form.lease_id,
      payment_date: form.payment_date,
      amount: Number(form.amount),
      method: form.method,
      check_number: form.check_number.trim() || null,
      notes: form.notes.trim() || null,
      idempotency_key: idempotencyKey,
    })
  }

  function handleCancel() {
    setShowForm(false)
    setForm(EMPTY)
    setIdempotencyKey(newIdempotencyKey())
    setErrors({})
  }

  // Build sorted lease options
  const leases = leasesQ.data ?? []
  const leaseOptions = [...leases]
    .map(l => {
      const tenantName = l.tenants?.name ?? '—'
      const propertyName = l.units?.properties?.name ?? '—'
      const suite = l.units?.suite ?? '—'
      const label = `${tenantName} · ${propertyName} · ${suite}`
      return { id: l.id, label }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const payments = paymentsQ.data ?? []

  return (
    <div>
      <PageHeader
        title="Payments"
        action={
          !showForm ? (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-1.5 rounded"
            >
              + Record Payment
            </button>
          ) : undefined
        }
      />

      {/* Inline Record Payment Form */}
      {showForm && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 max-w-2xl">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Record Payment</h3>
          <form onSubmit={handleSubmit} noValidate>
            {/* Lease */}
            <Field label="Lease" htmlFor="lease_id" required error={errors.lease_id}>
              <Select
                id="lease_id"
                value={form.lease_id}
                onChange={e => set('lease_id', e.target.value)}
              >
                <option value="">Select lease…</option>
                {leaseOptions.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            {/* Date & Amount row */}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Payment Date" htmlFor="payment_date" required error={errors.payment_date}>
                <DateInput
                  id="payment_date"
                  value={form.payment_date}
                  onChange={e => set('payment_date', e.target.value)}
                />
              </Field>
              <Field label="Amount ($)" htmlFor="amount" required error={errors.amount}>
                <NumberInput
                  id="amount"
                  value={form.amount}
                  onChange={e => set('amount', e.target.value)}
                  placeholder="e.g. 4500"
                  min={0.01}
                />
              </Field>
            </div>

            {/* Method & Check # row */}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Method" htmlFor="method" required>
                <Select
                  id="method"
                  value={form.method}
                  onChange={e => set('method', e.target.value)}
                >
                  <option value="check">Check</option>
                  <option value="wire">Wire</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Check #" htmlFor="check_number" hint="Optional">
                <TextInput
                  id="check_number"
                  value={form.check_number}
                  onChange={e => set('check_number', e.target.value)}
                  placeholder="e.g. 1042"
                />
              </Field>
            </div>

            {/* Notes */}
            <Field label="Notes" htmlFor="notes">
              <Textarea
                id="notes"
                value={form.notes}
                onChange={e => set('notes', e.target.value)}
                placeholder="Optional notes…"
              />
            </Field>

            {mutation.error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2 mb-3">
                {mutation.error.message}
              </p>
            )}

            <div className="flex items-center gap-3 mt-1">
              <button
                type="submit"
                disabled={mutation.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {mutation.isPending ? 'Saving…' : 'Record Payment'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Payment History Table */}
      {paymentsQ.isLoading ? (
        <p className="text-gray-500 text-sm p-4">Loading…</p>
      ) : payments.length === 0 ? (
        <p className="text-gray-500 text-sm">No payments recorded.</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Payment Date
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Tenant
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Method
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Check #
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.map(p => (
                <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-900">{formatDate(p.payment_date)}</td>
                  <td className="px-4 py-3 text-gray-900">
                    {p.leases?.tenants?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-900 text-right font-medium">
                    {formatCurrency(p.amount)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{p.method}</td>
                  <td className="px-4 py-3 text-gray-600">{p.check_number ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{p.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
