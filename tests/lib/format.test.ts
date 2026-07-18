import { describe, it, expect } from 'vitest'
import { formatCurrency, formatDate } from '../../src/lib/format'

describe('formatCurrency', () => {
  it('formats a plain-dollar NUMERIC value as-is, with no /100 cents conversion', () => {
    // Regression guard for the PortalDashboard bug (07-16 audit finding #3): total_balance,
    // payments.amount, and charges.amount are all plain-dollar NUMERIC columns
    // (0002_financial_tables.sql), not Stripe cents integers. A prior local `fmt()` in
    // PortalDashboard.tsx divided these by 100, rendering a $4,500 balance as $45.00.
    expect(formatCurrency(4500)).toBe('$4,500.00')
    expect(formatCurrency(45)).toBe('$45.00')
  })

  it('handles null/undefined', () => {
    expect(formatCurrency(null)).toBe('—')
    expect(formatCurrency(undefined)).toBe('—')
  })
})

describe('formatDate', () => {
  it('formats a date-only or timestamp string consistently', () => {
    expect(formatDate('2026-07-18')).toBe('Jul 18, 2026')
    expect(formatDate('2026-07-18T14:16:29Z')).toBe('Jul 18, 2026')
  })

  it('handles null/undefined', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
  })
})
