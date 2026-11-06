import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Task 4 review fix: the Expenses list lost its "Total" when it moved to server paging.
// The API now returns total_amount for the whole filter; the page shows it in the header.
describe('ExpensesList shows the whole-filter total', () => {
  const source = readFileSync(join(__dirname, '../../src/pages/expenses/ExpensesList.tsx'), 'utf-8')

  it('reads total_amount from the list response and renders "Total:" with formatCurrency', () => {
    expect(source).toMatch(/total_amount/)
    expect(source).toMatch(/subtitle=\{[^}]*Total: \$\{formatCurrency\(/)
  })
})
