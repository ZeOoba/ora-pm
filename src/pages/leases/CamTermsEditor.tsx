import { useState } from 'react'
import { useSaveMutation } from '../../lib/mutations'
import { Button } from '../../components/ui/Button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { Field } from '../../components/form/Field'
import { TextInput, Select, Checkbox } from '../../components/form/inputs'
import {
  CAM_CATEGORIES, CAM_CATEGORY_LABEL, CAM_CATEGORY_PRESETS, camTermsFormFromLease, camTermsPayload, validateCamTerms,
  type CamCategory, type CamRentType, type CamTermsErrors, type CamTermsForm, type CamTermsLease,
} from '../../lib/cam-terms'
import type { Lease } from '../../types'

/**
 * Edit an existing lease's CAM terms in place (REFUTE M2, 2026-11-10). Before this, a stated
 * Proportionate Share or base year could only be entered when the lease was created.
 * Saving does not touch any CAM draft: /cam/:id/approve recomputes and refuses a draft that no
 * longer matches the lease (REFUTE D1/D2), so the draft must be recalculated after an edit.
 */
export function CamTermsEditor({ leaseId, lease }: {
  leaseId: string
  lease: CamTermsLease
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

  function toggleCategory(c: CamCategory, on: boolean) {
    // Unticking from "All" starts from the full list minus this one.
    const current = form.recoverable_categories ?? [...CAM_CATEGORIES]
    const next = on ? [...new Set([...current, c])] : current.filter(x => x !== c)
    set('recoverable_categories', next.length === CAM_CATEGORIES.length ? null : next)
  }

  const presetActive = (cats: CamCategory[] | null) =>
    cats === null
      ? form.recoverable_categories === null
      : form.recoverable_categories !== null
        && form.recoverable_categories.length === cats.length
        && cats.every(c => form.recoverable_categories!.includes(c))

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
              hint="The base year's recoverable total for the categories ticked below (the whole pool only when All recoverable) — not the tenant's share."
            >
              <TextInput id="cam-base-amount" inputMode="decimal" value={form.base_year_expense_amount} onChange={e => set('base_year_expense_amount', e.target.value)} />
            </Field>
            <Field label="Expense stop ($/SF/yr)" htmlFor="cam-stop" error={errors.expense_stop_amount}>
              <TextInput id="cam-stop" inputMode="decimal" value={form.expense_stop_amount} onChange={e => set('expense_stop_amount', e.target.value)} />
            </Field>

            {/* 0024 (rulings 2026-11-10): what passes through, the annual cap, and exclusion. */}
            <fieldset className="mb-4 border-t border-border pt-4">
              <legend className="text-sm font-medium text-navy">Recovery</legend>
              <Checkbox
                id="cam-reconciled"
                label="CAM-reconciled (untick if the tenant pays expenses directly or a fixed charge is in rent)"
                checked={form.cam_reconciled}
                onChange={e => set('cam_reconciled', e.target.checked)}
              />
              {!form.cam_reconciled && (
                <Field label="Why it is not reconciled" htmlFor="cam-exclusion-reason" error={errors.cam_exclusion_reason}
                  hint="Shown on the CAM page. Any CAM estimate already billed must be credited manually.">
                  <TextInput id="cam-exclusion-reason" value={form.cam_exclusion_reason} onChange={e => set('cam_exclusion_reason', e.target.value)} />
                </Field>
              )}
              {/* Always shown (also when not reconciled) so no validation error is ever hidden. */}
              <>
                  <Field label="Recoverable categories" htmlFor="cam-cat-taxes" error={errors.recoverable_categories}
                    hint="Only recoverable expenses in these categories form this lease's pool. A base-year amount must cover the same categories.">
                    <div className="mb-2 flex flex-wrap gap-2">
                      {CAM_CATEGORY_PRESETS.map(p => (
                        <Button key={p.label} type="button" variant="ghost"
                          className={`border text-xs ${presetActive(p.categories) ? 'border-navy' : 'border-border'}`}
                          aria-pressed={presetActive(p.categories)}
                          onClick={() => set('recoverable_categories', p.categories === null ? null : [...p.categories])}>
                          {p.label}
                        </Button>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2">
                      {CAM_CATEGORIES.map(c => (
                        <Checkbox key={c} id={`cam-cat-${c}`} label={CAM_CATEGORY_LABEL[c]}
                          checked={form.recoverable_categories === null || form.recoverable_categories.includes(c)}
                          onChange={e => toggleCategory(c, e.target.checked)} />
                      ))}
                    </div>
                  </Field>
                  <Field label="Annual cap ($)" htmlFor="cam-cap" error={errors.cam_annual_cap}
                    hint="The most the tenant pays for the year; prorated for a partial year. Blank = no cap.">
                    <TextInput id="cam-cap" inputMode="decimal" value={form.cam_annual_cap} onChange={e => set('cam_annual_cap', e.target.value)} />
                  </Field>
                  <Field label="Cap applies through" htmlFor="cam-cap-through" error={errors.cam_cap_through}
                    hint="e.g. the initial term's end. Blank = for the whole term.">
                    <TextInput id="cam-cap-through" type="date" value={form.cam_cap_through} onChange={e => set('cam_cap_through', e.target.value)} />
                  </Field>
              </>
            </fieldset>
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
