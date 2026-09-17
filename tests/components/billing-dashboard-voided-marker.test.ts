import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-278 / migration 0016: the admin charges list (GET /api/charges, `select('*')`) still returns
// voided rows — they are the audit trail — so the table must make the voided state visible rather
// than render a voided $50 fee indistinguishably from a live one. No React-rendering harness exists
// in this repo (see portal-charge-field-drift.test.ts), so this reads the component source.
describe('BillingDashboard — voided charges are visibly marked', () => {
  const source = readFileSync(join(__dirname, '../../src/pages/billing/BillingDashboard.tsx'), 'utf-8')

  it('branches on the row\'s voided_at column', () => {
    expect(source).toMatch(/ch\.voided_at/)
  })

  it('renders a "Voided" marker', () => {
    expect(source).toMatch(/Voided/)
  })

  it('surfaces the void_reason (title/tooltip or inline) so the audit reason travels with the row', () => {
    expect(source).toMatch(/ch\.void_reason/)
  })
})
