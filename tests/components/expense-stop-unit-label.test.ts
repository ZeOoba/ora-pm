/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildExtractionRequest } from '../../server/lib/lease-extract'

// REFUTE C4d: leases.expense_stop_amount is $/SF per YEAR (what calculateCAMTrueUp assumes). The
// form said only "$/SF" and the extraction tool said nothing, so a monthly or total figure could be
// entered or extracted. Pin the unit everywhere the value is captured.
describe('expense stop unit is labelled $/SF/yr at every capture point', () => {
  it('LeaseForm labels the field "Expense Stop ($/SF/yr)"', () => {
    const src = readFileSync(join(__dirname, '../../src/pages/leases/LeaseForm.tsx'), 'utf-8')
    expect(src).toContain('label="Expense Stop ($/SF/yr)"')
  })

  it('the lease-extract tool schema describes expense_stop_amount as $/SF per year', () => {
    const tool = buildExtractionRequest('JVBER', 'model').tools[0]
    const desc = (tool.input_schema.properties.expense_stop_amount as { description?: string }).description ?? ''
    expect(desc).toMatch(/\$\/SF/)
    expect(desc).toMatch(/per year|\/yr/i)
  })
})
