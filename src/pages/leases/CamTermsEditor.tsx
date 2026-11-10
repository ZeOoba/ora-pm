import { useState } from 'react'
import { useSaveMutation } from '../../lib/mutations'
import { Button } from '../../components/ui/Button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { Field } from '../../components/form/Field'
import { TextInput, Select } from '../../components/form/inputs'
import { camTermsFormFromLease, camTermsPayload, validateCamTerms, type CamRentType, type CamTermsErrors, type CamTermsForm } from '../../lib/cam-terms'
import type { Lease } from '../../types'

/**
 * Edit an existing lease's CAM terms in place (REFUTE M2, 2026-11-10). Before this, a stated
 * Proportionate Share or base year could only be entered when the lease was created.
 * Saving does not touch any CAM draft: /cam/:id/approve recomputes and refuses a draft that no
 * longer matches the lease (REFUTE D1/D2), so the draft must be recalculated after an edit.
 */
export function CamTermsEditor({ leaseId, lease }: {
  leaseId: string
  lease: Pick<Lease, 'rent_type' | 'proportionate_share_pct' | 'base_year' | 'base_year_expense_amount' | 'expense_stop_amount'>
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<CamTermsForm>(() => camTermsFormFromLease(lease))
  const [errors, setErrors] = useState<CamTermsErrors>({})

  const mutation = useSaveMutation<Lease>({
    method: 'put',
    path: `/leases/${leaseId}`,
    invalidate: [['lease', leaseId], ['leases']],
    onSuccess: () => setOpen(false),
  })

  function openEditor() {
    setForm(camTermsFormFromLease(lease))
    setErrors({})
    mutation.reset()
    setOpen(true)
  }

  function set<K extends keyof CamTermsForm>(field: K, value: CamTermsForm[K]) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: undefined }))
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const errs = validateCamTerms(form)
    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      return
    }
    mutation.mutate(camTermsPayload(form))
  }

  return (
    <>
      <Button type="button" variant="ghost" className="border border-border" onClick={openEditor}>Edit CAM terms</Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>CAM terms</SheetTitle>
            <SheetDescription>
              Enter these exactly as the lease states them. After saving, recalculate this lease&apos;s CAM
              draft: an existing draft priced on the old terms will not approve.
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={submit} className="flex-1 overflow-y-auto px-4 pb-4" noValidate>
            <Field label="Rent type" htmlFor="cam-rent-type" hint="Gross = no CAM recovery.">
              <Select id="cam-rent-type" value={form.rent_type} onChange={e => set('rent_type', e.target.value as CamRentType)}>
                <option value="nnn">NNN</option>
                <option value="modified_gross">Modified gross (expense stop)</option>
                <option value="gross">Gross</option>
              </Select>
            </Field>
            <Field
              label="Proportionate Share (%)"
              htmlFor="cam-share"
              error={errors.proportionate_share_percent}
              hint={form.proportionate_share_percent !== '' && Number(form.proportionate_share_percent) > 0 && Number(form.proportionate_share_percent) <= 1
                ? `⚠ ${form.proportionate_share_percent}% — is that a fraction typed as a percent?`
                : 'As stated in the lease, e.g. 11.11. Blank = premises SF / property CAM denominator.'}
            >
              <TextInput id="cam-share" inputMode="decimal" value={form.proportionate_share_percent} onChange={e => set('proportionate_share_percent', e.target.value)} />
            </Field>
            <Field label="Base year" htmlFor="cam-base-year" error={errors.base_year} hint="Set only if the lease recovers increases over a base year.">
              <TextInput id="cam-base-year" inputMode="numeric" value={form.base_year} onChange={e => set('base_year', e.target.value)} />
            </Field>
            <Field
              label="Base-year recoverable total ($)"
              htmlFor="cam-base-amount"
              error={errors.base_year_expense_amount}
              hint="The whole pool's recoverable Operating Costs + Taxes for the base year — not the tenant's share."
            >
              <TextInput id="cam-base-amount" inputMode="decimal" value={form.base_year_expense_amount} onChange={e => set('base_year_expense_amount', e.target.value)} />
            </Field>
            <Field label="Expense stop ($/SF/yr)" htmlFor="cam-stop" error={errors.expense_stop_amount}>
              <TextInput id="cam-stop" inputMode="decimal" value={form.expense_stop_amount} onChange={e => set('expense_stop_amount', e.target.value)} />
            </Field>
            {mutation.error && (
              <p role="alert" className="mb-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm text-status-danger">
                {mutation.error.message}
              </p>
            )}
            <div className="flex gap-3">
              <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save'}</Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}
