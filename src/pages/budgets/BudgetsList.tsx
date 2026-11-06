import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { NumberInput, Select } from '../../components/form/inputs'
import { formatCurrency } from '../../lib/format'
import type { Budget, BudgetCategory, Property } from '../../types'

// ── Constants ──────────────────────────────────────────────────────────────

const INCOME_CATEGORIES: BudgetCategory[] = ['rental_income', 'cam_income', 'other_income']
const EXPENSE_CATEGORIES: BudgetCategory[] = ['taxes', 'insurance', 'maintenance', 'utilities', 'management', 'capital', 'other']
const ALL_CATEGORIES: BudgetCategory[] = [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES]

const CATEGORY_LABELS: Record<BudgetCategory, string> = {
  rental_income: 'Rental Income',
  cam_income: 'CAM Income',
  other_income: 'Other Income',
  taxes: 'Taxes',
  insurance: 'Insurance',
  maintenance: 'Maintenance',
  utilities: 'Utilities',
  management: 'Management',
  capital: 'Capital',
  other: 'Other',
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isIncomeCategory(cat: BudgetCategory): boolean {
  return INCOME_CATEGORIES.includes(cat)
}

/**
 * Variance color rule:
 *  - Income: actual >= budgeted → green (good); else red
 *  - Expense: actual <= budgeted → green (good); else red
 *  - variance of exactly 0 → gray
 */
function varianceClass(category: BudgetCategory, variance: number): string {
  if (variance === 0) return 'text-muted-foreground'
  if (isIncomeCategory(category)) {
    return variance > 0 ? 'text-status-active font-semibold' : 'text-status-danger font-semibold'
  } else {
    // expenses: positive variance = over budget = bad
    return variance < 0 ? 'text-status-active font-semibold' : 'text-status-danger font-semibold'
  }
}

function sum(categories: BudgetCategory[], amounts: Record<BudgetCategory, number>): number {
  return categories.reduce((acc, cat) => acc + (amounts[cat] ?? 0), 0)
}

// ── Types ──────────────────────────────────────────────────────────────────

type DraftAmounts = Partial<Record<BudgetCategory, string>>

// ── Main component ─────────────────────────────────────────────────────────

export function BudgetsList() {
  const currentYear = new Date().getFullYear()
  const [propertyId, setPropertyId] = useState<string>('')
  const [year, setYear] = useState<string>(String(currentYear))
  const [drafts, setDrafts] = useState<DraftAmounts>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const qc = useQueryClient()

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: properties, isLoading: propsLoading } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.listAll<Property>('/properties'),
  })

  const yearNum = Number(year)
  const enabled = !!propertyId && !!year && !isNaN(yearNum)

  const { data: budgets, isLoading: budgetsLoading } = useQuery({
    queryKey: ['budgets', propertyId, year],
    queryFn: () =>
      api.get<{ data: Budget[] }>(`/budgets?property_id=${propertyId}&year=${yearNum}`).then(r => r.data),
    enabled,
  })

  const { data: actualsResp, isLoading: actualsLoading } = useQuery({
    queryKey: ['actuals', propertyId, year],
    queryFn: () =>
      api.get<{ data: Record<string, number> }>(`/reports/actuals?property_id=${propertyId}&year=${yearNum}`).then(r => r.data),
    enabled,
  })

  // ── Derived state ─────────────────────────────────────────────────────────

  // Map from category → existing budgeted_amount (from DB)
  const savedAmounts: Partial<Record<BudgetCategory, number>> = {}
  for (const b of budgets ?? []) {
    savedAmounts[b.category] = b.budgeted_amount
  }

  const actuals: Record<BudgetCategory, number> = {} as Record<BudgetCategory, number>
  for (const cat of ALL_CATEGORIES) {
    actuals[cat] = actualsResp?.[cat] ?? 0
  }

  // Draft value for a category: prefer draft string, fall back to saved amount
  function getDraftValue(cat: BudgetCategory): string {
    if (drafts[cat] !== undefined) return drafts[cat]!
    const saved = savedAmounts[cat]
    return saved !== undefined ? String(saved) : ''
  }

  // Numeric budgeted value (for calculations)
  function getBudgeted(cat: BudgetCategory): number {
    const raw = getDraftValue(cat)
    const n = Number(raw)
    return isNaN(n) ? 0 : n
  }

  // Subtotals
  const budgetedIncome = sum(INCOME_CATEGORIES, Object.fromEntries(INCOME_CATEGORIES.map(c => [c, getBudgeted(c)])) as Record<BudgetCategory, number>)
  const budgetedExpense = sum(EXPENSE_CATEGORIES, Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c, getBudgeted(c)])) as Record<BudgetCategory, number>)
  const actualIncome = sum(INCOME_CATEGORIES, actuals)
  const actualExpense = sum(EXPENSE_CATEGORIES, actuals)
  const budgetedNet = budgetedIncome - budgetedExpense
  const actualNet = actualIncome - actualExpense

  // ── Save handler ─────────────────────────────────────────────────────────

  async function handleSave() {
    if (!propertyId || !year) return
    setSaving(true)
    setSaveError(null)
    try {
      // Only save categories that have a non-empty, numeric draft value
      const toSave = ALL_CATEGORIES.filter(cat => {
        const v = getDraftValue(cat)
        return v !== '' && !isNaN(Number(v))
      })
      await Promise.all(
        toSave.map(cat =>
          api.post('/budgets', {
            property_id: propertyId,
            year: yearNum,
            category: cat,
            budgeted_amount: Number(getDraftValue(cat)),
          })
        )
      )
      setDrafts({})
      qc.invalidateQueries({ queryKey: ['budgets', propertyId, year] })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Reset drafts when property/year changes
  function handlePropertyChange(newId: string) {
    setPropertyId(newId)
    setDrafts({})
    setSaveError(null)
  }

  function handleYearChange(newYear: string) {
    setYear(newYear)
    setDrafts({})
    setSaveError(null)
  }

  const isLoading = budgetsLoading || actualsLoading

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader title="Budgets" />

      {/* Controls */}
      <div className="flex items-end gap-4 mb-6">
        <div className="w-72">
          <Field label="Property" htmlFor="budget-property" required>
            <Select
              id="budget-property"
              value={propertyId}
              onChange={e => handlePropertyChange(e.target.value)}
              disabled={propsLoading}
            >
              <option value="">— Select property —</option>
              {(properties ?? []).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-28">
          <Field label="Year" htmlFor="budget-year" required>
            <NumberInput
              id="budget-year"
              value={year}
              onChange={e => handleYearChange(e.target.value)}
              min={2000}
              max={2100}
              step={1}
            />
          </Field>
        </div>
      </div>

      {/* Prompt */}
      {!propertyId && (
        <div className="bg-white rounded-lg border border-border p-10 text-center text-muted-foreground text-sm">
          Select a property to view its budget.
        </div>
      )}

      {/* Loading */}
      {propertyId && isLoading && (
        <p className="text-muted-foreground text-sm p-4">Loading…</p>
      )}

      {/* Budget table */}
      {propertyId && !isLoading && (
        <>
          <div className="bg-white rounded-lg border border-border overflow-hidden mb-4">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase w-48">Category</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase w-44">Budgeted</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase w-40">Actual</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase w-40">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">

                {/* Income section */}
                <tr className="bg-muted">
                  <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Income
                  </td>
                </tr>
                {INCOME_CATEGORIES.map(cat => {
                  const budgeted = getBudgeted(cat)
                  const actual = actuals[cat]
                  const variance = actual - budgeted
                  return (
                    <tr key={cat} className="hover:bg-muted">
                      <td className="px-4 py-2.5 text-foreground">{CATEGORY_LABELS[cat]}</td>
                      <td className="px-4 py-2.5 text-right">
                        <NumberInput
                          value={getDraftValue(cat)}
                          onChange={e => setDrafts(d => ({ ...d, [cat]: e.target.value }))}
                          min={0}
                          step="0.01"
                          placeholder="0"
                          className="text-right w-36 ml-auto"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right text-foreground">{formatCurrency(actual)}</td>
                      <td className={`px-4 py-2.5 text-right ${varianceClass(cat, variance)}`}>
                        {variance === 0 ? '—' : formatCurrency(variance)}
                      </td>
                    </tr>
                  )
                })}
                {/* Income subtotal */}
                <tr className="bg-primary/5 border-t border-border">
                  <td className="px-4 py-2.5 text-xs font-semibold text-primary uppercase">Total Income</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-primary">{formatCurrency(budgetedIncome)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-primary">{formatCurrency(actualIncome)}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold ${(actualIncome - budgetedIncome) >= 0 ? 'text-status-active' : 'text-status-danger'}`}>
                    {actualIncome === budgetedIncome ? '—' : formatCurrency(actualIncome - budgetedIncome)}
                  </td>
                </tr>

                {/* Expense section */}
                <tr className="bg-muted">
                  <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Expenses
                  </td>
                </tr>
                {EXPENSE_CATEGORIES.map(cat => {
                  const budgeted = getBudgeted(cat)
                  const actual = actuals[cat]
                  const variance = actual - budgeted
                  return (
                    <tr key={cat} className="hover:bg-muted">
                      <td className="px-4 py-2.5 text-foreground">{CATEGORY_LABELS[cat]}</td>
                      <td className="px-4 py-2.5 text-right">
                        <NumberInput
                          value={getDraftValue(cat)}
                          onChange={e => setDrafts(d => ({ ...d, [cat]: e.target.value }))}
                          min={0}
                          step="0.01"
                          placeholder="0"
                          className="text-right w-36 ml-auto"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right text-foreground">{formatCurrency(actual)}</td>
                      <td className={`px-4 py-2.5 text-right ${varianceClass(cat, variance)}`}>
                        {variance === 0 ? '—' : formatCurrency(variance)}
                      </td>
                    </tr>
                  )
                })}
                {/* Expense subtotal */}
                <tr className="bg-orange-50 border-t border-orange-100">
                  <td className="px-4 py-2.5 text-xs font-semibold text-orange-700 uppercase">Total Expenses</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-orange-700">{formatCurrency(budgetedExpense)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-orange-700">{formatCurrency(actualExpense)}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold ${(actualExpense - budgetedExpense) <= 0 ? 'text-status-active' : 'text-status-danger'}`}>
                    {actualExpense === budgetedExpense ? '—' : formatCurrency(actualExpense - budgetedExpense)}
                  </td>
                </tr>

                {/* Net line */}
                <tr className="bg-muted border-t-2 border-border">
                  <td className="px-4 py-3 text-xs font-bold text-foreground uppercase">Net Operating</td>
                  <td className="px-4 py-3 text-right font-bold text-foreground">{formatCurrency(budgetedNet)}</td>
                  <td className="px-4 py-3 text-right font-bold text-foreground">{formatCurrency(actualNet)}</td>
                  <td className={`px-4 py-3 text-right font-bold ${actualNet >= budgetedNet ? 'text-status-active' : 'text-status-danger'}`}>
                    {actualNet === budgetedNet ? '—' : formatCurrency(actualNet - budgetedNet)}
                  </td>
                </tr>

              </tbody>
            </table>
          </div>

          {/* Save controls */}
          {saveError && (
            <p className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded p-2 mb-3">
              {saveError}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save Budgets'}
            </button>
            <span className="text-xs text-muted-foreground">Saves all non-empty rows for {propertyId ? (properties?.find(p => p.id === propertyId)?.name ?? '') : ''} — {yearNum}</span>
          </div>
        </>
      )}
    </div>
  )
}
