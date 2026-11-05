import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSaveMutation } from '../../lib/mutations'
import { formatCurrency, formatDate } from '../../lib/format'
import { PageHeader } from '../../components/PageHeader'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { DataTable, type FilterDef } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { Field } from '../../components/form/Field'
import { TextInput, NumberInput, DateInput, Select, Textarea, Checkbox } from '../../components/form/inputs'
import { Trash2 } from 'lucide-react'
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

// ── Table columns ──────────────────────────────────────────────────────────

const h = dataTableColumnHelper<ExpenseRow>()

// Sortable ids match the server allowlist: expense_date, amount, category.
function buildColumns(onDelete: (id: string) => void | Promise<void>) {
  return [
    h.accessor('expense_date', {
      header: 'Date',
      enableSorting: true,
      cell: ({ row }) => <span className="whitespace-nowrap">{formatDate(row.original.expense_date)}</span>,
    }),
    h.accessor((e) => e.properties?.name, {
      id: 'property',
      header: 'Property',
      cell: ({ row }) => row.original.properties?.name ?? '—',
    }),
    h.accessor('category', {
      header: 'Category',
      enableSorting: true,
      meta: { csv: (e: ExpenseRow) => CATEGORY_LABELS[e.category] },
      cell: ({ row }) => CATEGORY_LABELS[row.original.category],
    }),
    h.accessor('vendor', {
      header: 'Vendor',
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.vendor ?? '—'}</span>,
    }),
    h.accessor('amount', {
      header: 'Amount',
      enableSorting: true,
      meta: { numeric: true },
      cell: ({ row }) => <span className="font-medium">{formatCurrency(row.original.amount)}</span>,
    }),
    h.accessor('recoverable', {
      header: 'Recoverable',
      meta: { csv: (e: ExpenseRow) => (e.recoverable ? 'Yes' : 'No') },
      cell: ({ row }) =>
        row.original.recoverable ? <Badge tone="active">✓ CAM</Badge> : <span className="text-muted-foreground">—</span>,
    }),
    h.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => onDelete(row.original.id)}
          className="text-muted-foreground transition-colors hover:text-status-danger"
          title="Delete expense"
          aria-label="Delete expense"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      ),
    }),
  ]
}

// ── Component ──────────────────────────────────────────────────────────────

export function ExpensesList() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<ExpenseForm>(EMPTY_FORM)
  const [errors, setErrors] = useState<ExpenseErrors>({})
  // Whole-filter total from the list response (all pages, current property filter).
  const [totalAmount, setTotalAmount] = useState<string | null>(null)
  const handlePageData = useCallback((page: Record<string, unknown>) => {
    setTotalAmount(typeof page.total_amount === 'string' ? page.total_amount : null)
  }, [])

  // Properties feed the filter dropdown and the form picker.
  const { data: propertiesData } = useQuery({
    queryKey: ['properties', 'picker'],
    queryFn: () => api.listAll<Property>('/properties', { sort: 'name', dir: 'asc' }),
  })
  const properties = useMemo(() => propertiesData ?? [], [propertiesData])
  const filters = useMemo<FilterDef[]>(
    () => [{ id: 'property_id', label: 'Property', options: properties.map(p => ({ value: p.id, label: p.name })) }],
    [properties],
  )

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

  // Delete behavior unchanged (Task 6 replaces confirm()); refreshes the DataTable query.
  const columns = useMemo(
    () =>
      buildColumns(async (id) => {
        if (!confirm('Delete this expense?')) return
        await api.del(`/expenses/${id}`)
        qc.invalidateQueries({ queryKey: ['expenses'] })
      }),
    [qc],
  )

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
        subtitle={totalAmount !== null ? `Total: ${formatCurrency(Number(totalAmount))}` : undefined}
        action={
          <Button type="button" onClick={() => setShowForm(true)}>
            + Add Expense
          </Button>
        }
      />

      <Sheet open={showForm} onOpenChange={(open) => { if (!open) handleCancel() }}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Add Expense</SheetTitle>
            <SheetDescription>Log a property expense; mark it recoverable to feed CAM reconciliation.</SheetDescription>
          </SheetHeader>
          <form onSubmit={handleSubmit} noValidate className="px-4 pb-4">
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
              <p className="mb-3 rounded border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">
                {mutation.error.message}
              </p>
            )}

            <div className="mt-1 flex items-center gap-3">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Add Expense'}
              </Button>
              <Button type="button" variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <DataTable<ExpenseRow>
        columns={columns}
        queryKey={['expenses', 'list']}
        fetchPage={(p) => api.list<ExpenseRow>('/expenses', p)}
        onPageData={handlePageData}
        searchable={false}
        filters={filters}
        csvFilename={csvFilename('expenses')}
        initialSort={{ id: 'expense_date', desc: true }}
        emptyTitle="No expenses logged"
      />
    </div>
  )
}
