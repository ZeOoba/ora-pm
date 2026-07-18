import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression guard for the 2026-07-16 audit finding #3: PortalDashboard.tsx previously
// defined a local fmt(cents) that divided plain-dollar total_balance/amount fields by 100.
// tests/lib/format.test.ts alone can't catch a reintroduction of that bug at the
// PortalDashboard call site, since formatCurrency/formatDate were never the buggy code —
// the bug was a local wrapper around them. This test reads the component source directly
// so a future re-introduction of a local cents-dividing formatter fails CI even without
// a React-rendering test harness (none exists in this repo).
describe('PortalDashboard source — no reintroduced cents/100 formatter', () => {
  const source = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalDashboard.tsx'),
    'utf-8'
  )

  it('imports the canonical formatCurrency/formatDate from lib/format', () => {
    expect(source).toMatch(/import\s*\{\s*formatCurrency\s*,\s*formatDate\s*\}\s*from\s*['"]\.\.\/\.\.\/lib\/format['"]/)
  })

  it('does not define a local currency formatter that divides by 100', () => {
    expect(source).not.toMatch(/function\s+fmt\s*\(/)
    expect(source).not.toMatch(/\/\s*100/)
  })
})
