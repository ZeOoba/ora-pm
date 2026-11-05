import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ComponentType } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// api.ts pulls in the Supabase client (needs env at import time); the render
// is the loading state only, so no request is ever made.
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}))

import { PropertiesList } from '../../src/pages/properties/PropertiesList'
import { TenantsList } from '../../src/pages/tenants/TenantsList'
import { LeasesList } from '../../src/pages/leases/LeasesList'
import { UnitsPage } from '../../src/pages/units/UnitsPage'
import { BillingDashboard } from '../../src/pages/billing/BillingDashboard'
import { PaymentsList } from '../../src/pages/payments/PaymentsList'
import { ExpensesList } from '../../src/pages/expenses/ExpensesList'
import { InsuranceList } from '../../src/pages/insurance/InsuranceList'
import { RenewalsPipeline } from '../../src/pages/renewals/RenewalsPipeline'
import { RentRoll } from '../../src/pages/reports/RentRoll'

function render(Page: ComponentType) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(MemoryRouter, null, createElement(Page)),
    ),
  )
}

describe('list pages render through DataTable (loading state)', () => {
  const cases: [string, ComponentType, string, { search: boolean; csv: boolean }][] = [
    ['PropertiesList', PropertiesList, 'Properties', { search: true, csv: true }],
    ['TenantsList', TenantsList, 'Tenants', { search: true, csv: true }],
    ['LeasesList', LeasesList, 'Leases', { search: false, csv: true }],
    ['UnitsPage', UnitsPage, 'Unit Matrix', { search: false, csv: true }],
    ['BillingDashboard', BillingDashboard, 'Billing', { search: false, csv: true }],
    ['PaymentsList', PaymentsList, 'Payments', { search: false, csv: true }],
    ['ExpensesList', ExpensesList, 'Expenses', { search: false, csv: true }],
    ['InsuranceList', InsuranceList, 'Insurance Certificates', { search: false, csv: true }],
    ['RenewalsPipeline', RenewalsPipeline, 'Renewals', { search: false, csv: true }],
    ['RentRoll', RentRoll, 'Rent Roll', { search: true, csv: true }],
  ]

  for (const [name, Page, title, expected] of cases) {
    it(`${name}: header, skeleton rows, ${expected.search ? 'search box' : 'no search box'}`, () => {
      const html = render(Page)
      expect(html).toContain(title)
      expect(html).toContain('data-slot="skeleton"')
      expect(html.includes('type="search"')).toBe(expected.search)
      expect(html.includes('Export CSV')).toBe(expected.csv)
    })
  }

  it('LeasesList offers the real lease status filter', () => {
    expect(render(LeasesList)).toContain('aria-label="Status"')
  })

  // The stored status can disagree with the status the API recomputes from expiration_date, so
  // sorting by it would order rows by a value the user never sees. Expiration stays sortable.
  it('InsuranceList: Expiration is sortable, Status is not', () => {
    const html = render(InsuranceList)
    expect(html).toMatch(/<button type="button"[^>]*>Expiration</)
    expect(html).toContain('>Status<')
    expect(html).not.toMatch(/<button type="button"[^>]*>Status</)
  })

  it('PaymentsList / ExpensesList keep the form behind a toolbar button, closed by default', () => {
    expect(render(PaymentsList)).toContain('+ Record Payment')
    expect(render(PaymentsList)).not.toContain('Select lease')
    expect(render(ExpensesList)).toContain('+ Add Expense')
    expect(render(ExpensesList)).not.toContain('Select category')
  })
})
