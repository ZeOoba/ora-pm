import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Phase 1 / Task 4: every list page renders through <DataTable>. A hand-rolled
// `<table className="min-w-full divide-y …">` coming back would silently drop
// server paging, sorting and CSV export, so guard the migrated files by source.
// (UnitMatrix is deliberately absent: it is the compact per-property embed on
// PropertyDetail, not a list page.)
const MIGRATED = [
  'properties/PropertiesList',
  'units/UnitsPage',
  'tenants/TenantsList',
  'leases/LeasesList',
  'billing/BillingDashboard',
  'payments/PaymentsList',
  'expenses/ExpensesList',
  'insurance/InsuranceList',
  'renewals/RenewalsPipeline',
  'reports/RentRoll',
]

describe('migrated list pages use DataTable, not hand-rolled tables', () => {
  for (const page of MIGRATED) {
    const source = readFileSync(join(__dirname, `../../src/pages/${page}.tsx`), 'utf-8')

    it(`${page} has no hand-rolled table markup`, () => {
      expect(source).not.toContain('min-w-full divide-y')
      expect(source).not.toMatch(/<table[\s>]/)
    })

    it(`${page} renders <DataTable`, () => {
      expect(source).toMatch(/<DataTable[<\s]/)
    })

    it(`${page} uses semantic tokens, not raw gray/blue palette classes`, () => {
      expect(source).not.toMatch(/\b(?:bg|text|border)-(?:gray|blue)-\d/)
    })

    it(`${page} exports CSV as ora-<page>-YYYY-MM-DD.csv`, () => {
      expect(source).toMatch(/csvFilename=\{csvFilename\('[a-z-]+'\)\}/)
    })
  }
})
