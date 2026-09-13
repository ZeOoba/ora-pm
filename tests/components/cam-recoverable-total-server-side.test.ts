/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression guard: CAMList.tsx summed total_property_recoverable_expenses — the figure POSTed to
// /cam/calculate for every tenant's true-up — in the browser from GET /expenses. That endpoint
// returns one PaginationSchema page (50 rows by default), so the total silently dropped every
// expense past the page, and its `new Date(expense_date).getFullYear()` year test shifted Jan 1
// expenses into the prior year (UTC parse, local read). The total must come from the server's
// fully-paged GET /cam/recoverable-expenses. Source scan, not a render test: this repo has no
// React-rendering harness (see portal-dashboard-no-cents-division.test.ts).
describe('CAMList source — recoverable total comes from the server, complete', () => {
  // Comments stripped (block, JSX-block and line) so a comment naming a guard can't satisfy a check.
  const source = readFileSync(join(__dirname, '../../src/pages/cam/CAMList.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

  it('fetches the server-side total from /cam/recoverable-expenses with property_id and year', () => {
    expect(source).toMatch(/\/cam\/recoverable-expenses\?property_id=\$\{[^}]+\}&year=\$\{[^}]+\}/)
  })

  it('no longer reads the paginated /expenses list or sums/filters expenses client-side', () => {
    expect(source).not.toMatch(/['"`]\/expenses/)
    expect(source).not.toMatch(/getFullYear\(\)\s*===\s*year/)
    expect(source).not.toMatch(/\.recoverable\b/)
  })

  it("keys the query under ['expenses', …] so ExpensesList's invalidateQueries(['expenses']) still refreshes it", () => {
    expect(source).toMatch(/queryKey:\s*\[\s*'expenses'\s*,\s*'cam-recoverable'/)
  })

  it('does not calculate from a total that has not loaded, failed, or is mid-refetch', () => {
    // Ready means a SETTLED success: isSuccess alone stays true during a background refetch.
    expect(source).toMatch(/const recoverableReady\s*=\s*recoverable\.isSuccess\s*&&\s*!recoverable\.isFetching\b/)
    // Both entry points are gated: the handler itself and the button's disabled state.
    const calc = source.slice(source.indexOf('async function handleCalculate'))
    expect(calc.slice(0, calc.indexOf('setCalculating(true)'))).toMatch(/!recoverableReady\b/)
    expect(source).toMatch(/const canCalculate\s*=[^\n]*\brecoverableReady\b/)
    expect(source).toMatch(/disabled=\{!canCalculate\}/)
  })
})
