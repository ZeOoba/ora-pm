import { useState } from 'react'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { Button } from '../../components/ui/Button'
import { Field } from '../../components/form/Field'
import { DateInput, NumberInput, Textarea } from '../../components/form/inputs'
import { useSaveMutation } from '../../lib/mutations'
import { cn } from '../../lib/utils'
import { COLLECTIONS_KEY } from './collections-records'

export type RecordKind = 'promise' | 'dispute'

export interface RecordTarget {
  lease_id: string
  label: string
}

const EMPTY = { amount: '', promised_date: '', notes: '', reason: '' }

/**
 * Log a promise to pay or a dispute against one lease. A work-log entry only: it changes no
 * balance and does not pause or trigger any billing or late fee.
 */
export function CollectionsRecordSheet({ target, initialKind = 'promise', onClose }: {
  target: RecordTarget | null
  initialKind?: RecordKind
  onClose: () => void
}) {
  const [kind, setKind] = useState<RecordKind>(initialKind)
  const [form, setForm] = useState(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const mutation = useSaveMutation({
    method: 'post',
    path: kind === 'promise' ? '/collections/promises' : '/collections/disputes',
    invalidate: [[...COLLECTIONS_KEY]],
    onSuccess: () => {
      toast.success(kind === 'promise' ? 'Promise to pay recorded' : 'Dispute recorded')
      close()
    },
  })

  function close() {
    setForm(EMPTY)
    setErrors({})
    mutation.reset()
    onClose()
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!target) return
    const errs: Record<string, string> = {}
    const amount = form.amount.trim() === '' ? null : Number(form.amount)
    if (kind === 'promise') {
      if (amount == null || !(amount > 0)) errs.amount = 'Enter a positive amount'
      if (!form.promised_date) errs.promised_date = 'Required'
    } else {
      if (amount != null && !(amount > 0)) errs.amount = 'Leave blank or enter a positive amount'
      if (!form.reason.trim()) errs.reason = 'Required'
    }
    if (amount != null && Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) errs.amount = 'At most two decimal places'
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    mutation.mutate(kind === 'promise'
      ? { lease_id: target.lease_id, amount, promised_date: form.promised_date, notes: form.notes.trim() || null }
      : { lease_id: target.lease_id, amount, reason: form.reason.trim() })
  }

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Sheet open={!!target} onOpenChange={(open) => { if (!open) close() }}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{kind === 'promise' ? 'Log promise to pay' : 'Log dispute'}</SheetTitle>
          <SheetDescription>{target?.label}. A record for the collections queue: it does not change the balance or any late fee.</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} noValidate className="flex-1 overflow-y-auto px-4 pb-4">
          <div role="radiogroup" aria-label="Record type" className="mb-4 flex gap-1.5 text-[13px]">
            {(['promise', 'dispute'] as RecordKind[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setErrors({}) }}
                className={cn('rounded-full border px-3 py-1.5', kind === k ? 'border-navy bg-navy text-white' : 'border-border bg-card text-navy hover:bg-muted')}>
                {k === 'promise' ? 'Promise to pay' : 'Dispute'}
              </button>
            ))}
          </div>
          <Field label={kind === 'promise' ? 'Amount promised' : 'Amount disputed'} htmlFor="rec-amount" required={kind === 'promise'}
            error={errors.amount} hint={kind === 'dispute' ? 'Optional' : undefined}>
            <NumberInput id="rec-amount" value={form.amount} onChange={set('amount')} min={0.01} step="0.01" placeholder="0.00" />
          </Field>
          {kind === 'promise' ? (
            <>
              <Field label="Promised by" htmlFor="rec-date" required error={errors.promised_date}>
                <DateInput id="rec-date" value={form.promised_date} onChange={set('promised_date')} />
              </Field>
              <Field label="Notes" htmlFor="rec-notes" hint="Who promised, how (call, email)">
                <Textarea id="rec-notes" value={form.notes} onChange={set('notes')} rows={2} maxLength={2000} />
              </Field>
            </>
          ) : (
            <Field label="What is disputed" htmlFor="rec-reason" required error={errors.reason}>
              <Textarea id="rec-reason" value={form.reason} onChange={set('reason')} rows={3} maxLength={2000} placeholder="e.g. 2025 CAM reconciliation; asked for backup" />
            </Field>
          )}
          {mutation.error && (
            <p role="alert" className="mb-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">{mutation.error.message}</p>
          )}
          <div className="flex gap-3">
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
