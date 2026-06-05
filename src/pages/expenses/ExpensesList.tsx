import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { formatCurrency, formatDate } from '../../lib/format'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { TextInput, NumberInput, DateInput, Select, Textarea, Checkbox } from '../../components/form/inputs'
import type { Expense, ExpenseCategory, Property } from '../../types'

// ── Types ──────────────────────────────────────────────────────────────────

type ExpenseRow = Expense & { properties: { name: string } | null }

// ── Constants ──────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  taxes: 'Taxes',
  insurance: 'Insurance',
  maintenance: 'Maintenance',
  utilities: 'Utilities',
  management: 'Management',
  capital: 'Capital',
  other: 'Other',
}

const TODAY = new Date().toISOString().slice(0, 10)

interface ExpenseForm {
  property_id: string
  expense_date: string
  category: ExpenseCategory | ''
  vendor: string
  amount: string
  recoverable: boolean
  invoice_ref: string
  description: string
}

interface ExpenseErrors {
  property_id?: string
  expense_date?: string
  category?: string
  amount?: string
}

const EMPTY_FORM: ExpenseForm = {
  property_id: '',
  expense_date: TODAY,
  category: '',
  vendor: '',
  amount: '',
  recoverable: false,
  invoice_ref: '',
  description: '',
}

// ── Validation ─────────────────────────────────────────────────────────────

function validate(f: ExpenseForm): ExpenseErrors {
  const e: ExpenseErrors = {}
  if (!f.property_id) e.property_id = 'Required'
  if (!f.expense_date) e.expense_date = 'Required'
  if (!f.category) e.category = 'Required'
  const amt = Number(f.amount)
  if (!f.amount || isNaN(amt) || amt <= 0) e.amount = 'Enter a positive amount'
  return e
}

// ── Component ──────────────────────────────────────────────────────────────

export function ExpensesList() {
  const qc = useQueryClient()
  const [propertyFilter, setPropertyFilter] = useState<string>('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<ExpenseForm>(EMPTY_FORM)
  const [errors, setErrors] = useState<ExpenseErrors>({})

  // Fetch properties for filter dropdown and form
  const { data: propertiesData } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ data: Property[] }>('/properties').then(r => r.data),
  })
  const properties = propertiesData ?? []

  // Fetch expenses, filtered by property if set
  const expensesQueryKey = propertyFilter
    ? ['expenses', { property_id: propertyFilter }]
    : ['expenses']

  const { data: expensesData, isLoading } = useQuery({
    queryKey: expensesQueryKey,
    queryFn: () => {
      const url = propertyFilter
        ? `/expenses?property_id=${encodeURIComponent(propertyFilter)}`
        : '/expenses'
      return api.get<{ data: ExpenseRow[] }>(url).then(r => r.data)
    },
  })
  const expenses: ExpenseRow[] = expensesData ?? []

  // Sort most-recent first
  const sorted = [...expenses].sort(
    (a, b) => new Date(b.expense_date).getTime() - new Date(a.expense_date).getTime()
  )

  const total = expenses.reduce((sum, e) => sum + e.amount, 0)

  // ── Mutation ───────────────────────────────────────────────────────────────

  const mutation = useSaveMutation<Expense>({
    method: 'post',
    path: '/expenses',
    invalidate: [['expenses']],
    onSuccess: () => {
      setForm(EMPTY_FORM)
      setShowForm(false)
      setErrors({})
    },
  })

  // ── Handlers ───────────────────────────────────────────────────────────────

  function setField<K extends keyof ExpenseForm>(field: K, value: ExpenseForm[K]) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field as keyof ExpenseErrors]) {
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
      property_id: form.property_id,
      expense_date: form.expense_date,
      category: form.category as ExpenseCategory,
      vendor: form.vendor.trim() || null,
      amount: Number(form.amount),
      recoverable: form.recoverable,
      invoice_ref: form.invoice_ref.trim() || null,
      description: form.description.trim() || null,
    })
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this expense?')) return
    await api.del(`/expenses/${id}`)
    qc.invalidateQueries({ queryKey: ['expenses'] })
  }

  function handleCancel() {
    setShowForm(false)
    setForm(EMPTY_FORM)
    setErrors({})
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader
        title="Expenses"
        action={
          !showForm ? (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded"
            >
              + Add Expense
            </button>
          ) : undefined
        }
      />

      {/* Property filter */}
      <div className="mb-4 max-w-xs">
        <Select
          id="property-filter"
          value={propertyFilter}
          onChange={e => setPropertyFilter(e.target.value)}
        >
          <option value="">All properties</option>
          {properties.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </div>

      {/* Add Expense inline form */}
      {showForm && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Add Expense</h3>
          <form onSubmit={handleSubmit} noValidate>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Property" htmlFor="exp-property" required error={errors.property_id}>
                <Select
                  id="exp-property"
                  value={form.property_id}
                  onChange={e => setField('property_id', e.target.value)}
                >
                  <option value="">Select property…</option>
                  {properties.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>

              <Field label="Date" htmlFor="exp-date" required error={errors.expense_date}>
                <DateInput
                  id="exp-date"
                  value={form.expense_date}
                  onChange={e => setField('expense_date', e.target.value)}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Category" htmlFor="exp-category" required error={errors.category}>
                <Select
                  id="exp-category"
                  value={form.category}
                  onChange={e => setField('category', e.target.value as ExpenseCategory | '')}
                >
                  <option value="">Select category…</option>
                  <option value="taxes">Taxes</option>
                  <option value="insurance">Insurance</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="utilities">Utilities</option>
                  <option value="management">Management</option>
                  <option value="capital">Capital</option>
                  <option value="other">Other</option>
                </Select>
              </Field>

              <Field label="Vendor" htmlFor="exp-vendor">
                <TextInput
                  id="exp-vendor"
                  value={form.vendor}
                  onChange={e => setField('vendor', e.target.value)}
                  placeholder="e.g. City of Columbus"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount ($)" htmlFor="exp-amount" required error={errors.amount}>
                <NumberInput
                  id="exp-amount"
                  value={form.amount}
                  onChange={e => setField('amount', e.target.value)}
                  placeholder="0.00"
                  min={0.01}
                  step="0.01"
                />
              </Field>

              <Field label="Invoice Ref" htmlFor="exp-invoice" hint="Optional invoice or check number">
                <TextInput
                  id="exp-invoice"
                  value={form.invoice_ref}
                  onChange={e => setField('invoice_ref', e.target.value)}
                  placeholder="INV-2024-001"
                />
              </Field>
            </div>

            <Checkbox
              label="Recoverable via CAM — feeds into annual CAM reconciliation"
              checked={form.recoverable}
              onChange={e => setField('recoverable', e.target.checked)}
            />

            <Field label="Description" htmlFor="exp-description">
              <Textarea
                id="exp-description"
                value={form.description}
                onChange={e => setField('description', e.target.value)}
                placeholder="Optional notes about this expense…"
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
                {mutation.isPending ? 'Saving…' : 'Add Expense'}
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

      {/* Expenses table */}
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="text-gray-500 text-sm">No expenses logged.</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2 font-semibold text-gray-600">Date</th>
                <th className="text-left px-4 py-2 font-semibold text-gray-600">Property</th>
                <th className="text-left px-4 py-2 font-semibold text-gray-600">Category</th>
                <th className="text-left px-4 py-2 font-semibold text-gray-600">Vendor</th>
                <th className="text-right px-4 py-2 font-semibold text-gray-600">Amount</th>
                <th className="text-center px-4 py-2 font-semibold text-gray-600">Recoverable</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(e => (
                <tr key={e.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-2 text-gray-700 whitespace-nowrap">
                    {formatDate(e.expense_date)}
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {e.properties?.name ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {CATEGORY_LABELS[e.category]}
                  </td>
                  <td className="px-4 py-2 text-gray-500">
                    {e.vendor ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-medium text-gray-900 tabular-nums">
                    {formatCurrency(e.amount)}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {e.recoverable ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                        ✓ CAM
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(e.id)}
                      className="text-gray-400 hover:text-red-600 transition-colors"
                      title="Delete expense"
                      aria-label="Delete expense"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 border-t border-gray-200">
                <td colSpan={4} className="px-4 py-2 text-sm font-semibold text-gray-600">
                  Total ({sorted.length} expense{sorted.length !== 1 ? 's' : ''})
                </td>
                <td className="px-4 py-2 text-right font-semibold text-gray-900 tabular-nums">
                  {formatCurrency(total)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
