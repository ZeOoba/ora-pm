import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/Button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { api } from '../../lib/api'
import { isDedupedConflict } from '../../lib/api-error'
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

// ── Table columns ─────────────────────────────────────────────────────────────

const h = dataTableColumnHelper<PaymentRow>()

// Sortable ids match the server allowlist: payment_date, amount.
const columns = [
  h.accessor('payment_date', {
    header: 'Payment Date',
    enableSorting: true,
    cell: ({ row }) => formatDate(row.original.payment_date),
  }),
  h.accessor((p) => p.leases?.tenants?.name, {
    id: 'tenant',
    header: 'Tenant',
    cell: ({ row }) => row.original.leases?.tenants?.name ?? '—',
  }),
  h.accessor('amount', {
    header: 'Amount',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => <span className="font-medium">{formatCurrency(row.original.amount)}</span>,
  }),
  h.accessor('method', {
    header: 'Method',
    cell: ({ row }) => <span className="capitalize text-muted-foreground">{row.original.method}</span>,
  }),
  h.accessor('check_number', {
    header: 'Check #',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.check_number ?? '—'}</span>,
  }),
  h.accessor('notes', {
    header: 'Notes',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.notes ?? '—'}</span>,
  }),
]

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
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<FormErrors>({})
  const [idempotencyKey, setIdempotencyKey] = useState<string>(newIdempotencyKey)
  // OI-082 follow-up: a 409 `deduped: true` means this payment is ALREADY
  // recorded (from an earlier click of this same form session) — it is not a
  // failure to show as a sticky red error. Left unhandled, the form would
  // keep the now-stale idempotencyKey after the 409, so if the admin then
  // edited the amount/date to enter a genuinely DIFFERENT second payment and
  // resubmitted, that different payment would hit the SAME key and ALSO come
  // back "already recorded" — silently never inserting it. Treating deduped
  // as settled (reset form, fresh key, refetch the lists) closes that gap.
  const [infoMessage, setInfoMessage] = useState<string | null>(null)

  // Active leases for dropdown
  // /leases is paged (default 50): ask for the endpoint maximum so the picker
  // lists every active lease.
  const leasesQ = useQuery({
    queryKey: ['leases', 'active', 'picker'],
    queryFn: () =>
      api.listAll<LeaseWithJoins>('/leases', { status: 'active' }),
  })

  const mutation = useSaveMutation<Payment>({
    method: 'post',
    path: '/payments',
    invalidate: [['payments'], ['ar-aging']],
    onSuccess: () => {
      setInfoMessage(null)
      setForm(EMPTY)
      setIdempotencyKey(newIdempotencyKey())
      setShowForm(false)
    },
    onError: (err) => {
      if (!isDedupedConflict(err)) return
      // Already recorded — not a failure. Refetch (the earlier attempt's row
      // is real and won't show up otherwise), clear the mutation's error
      // state so it doesn't also render as a red banner below, arm a fresh
      // key so a NEXT submission (same content or edited) can actually
      // insert, and tell the admin plainly rather than leaving the form
      // looking broken.
      qc.invalidateQueries({ queryKey: ['payments'] })
      qc.invalidateQueries({ queryKey: ['ar-aging'] })
      mutation.reset()
      setForm(EMPTY)
      setIdempotencyKey(newIdempotencyKey())
      setShowForm(false)
      setInfoMessage('This payment was already recorded — see it in the list below.')
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
    setInfoMessage(null)
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

  return (
    <div>
      <PageHeader
        title="Payments"
        action={
          <Button type="button" onClick={() => { setInfoMessage(null); setShowForm(true) }}>
            + Record Payment
          </Button>
        }
      />

      {infoMessage && (
        <p className="mb-4 max-w-2xl rounded border border-border bg-muted p-2 text-sm text-primary">
          {infoMessage}
        </p>
      )}

      <Sheet open={showForm} onOpenChange={(open) => { if (!open) handleCancel() }}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Record Payment</SheetTitle>
            <SheetDescription>Manual check, wire or other payment against an active lease.</SheetDescription>
          </SheetHeader>
          <form onSubmit={handleSubmit} noValidate className="px-4 pb-4">
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
              <p className="mb-3 rounded border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">
                {mutation.error.message}
              </p>
            )}

            <div className="mt-1 flex items-center gap-3">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Record Payment'}
              </Button>
              <Button type="button" variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <DataTable<PaymentRow>
        columns={columns}
        queryKey={['payments', 'list']}
        fetchPage={(p) => api.list<PaymentRow>('/payments', p)}
        searchable={false}
        csvFilename={csvFilename('payments')}
        initialSort={{ id: 'payment_date', desc: true }}
        emptyTitle="No payments recorded"
      />
    </div>
  )
}
