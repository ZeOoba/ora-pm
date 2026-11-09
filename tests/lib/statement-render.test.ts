import { describe, it, expect } from 'vitest'
import { buildStatement } from '../../server/lib/statement'
import { renderStatementEmail, formatCents, type StatementHeader } from '../../server/lib/statement-render'

const header = (over: Partial<StatementHeader> = {}): StatementHeader => ({
  leaseId: 'lease-1', tenantName: 'Acme Widgets Inc', contactName: 'Pat Doe',
  propertyName: 'Test Park', propertyAddress: '100 Main St, Columbus, OH 43215', suite: 'B2',
  entityLlc: 'Test Park Holdings LLC', ...over,
})
const stmt = () => buildStatement({
  charges: [
    { id: 'c1', charge_date: '2026-10-01', due_date: '2026-10-01', type: 'rent', description: null, amountCents: 123456 },
    { id: 'c2', charge_date: '2026-10-06', due_date: '2026-10-06', type: 'late_fee', description: null, amountCents: 5000 },
  ],
  payments: [
    { id: 'p1', payment_date: '2026-10-20', method: 'check', stripe_status: null, check_number: '1042', amountCents: 100000 },
    { id: 'p2', payment_date: '2026-10-28', method: 'ach_stripe', stripe_status: 'processing', check_number: null, amountCents: 20000 },
  ],
  start: '2026-10-01', end: '2026-10-31',
})

describe('formatCents', () => {
  it('formats dollars with thousands separators and negatives', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(-200)).toBe('-$2.00')
    expect(formatCents(5)).toBe('$0.05')
  })
})

describe('renderStatementEmail', () => {
  it('subject names the property, suite and period on one line', () => {
    const { subject } = renderStatementEmail(stmt(), header())
    expect(subject).toBe('Statement of Account — Test Park, Suite B2 — 10/01/2026 to 10/31/2026')
    expect(subject).not.toMatch(/[\r\n]/)
  })

  it('body carries the totals, lines, pending memo and aging', () => {
    const { html } = renderStatementEmail(stmt(), header())
    expect(html).toContain('$1,234.56')
    expect(html).toContain('Late fee')
    expect(html).toContain('check #1042')
    expect(html).toContain('$200.00') // pending ACH memo
    expect(html).toMatch(/not yet cleared/i)
    expect(html).toContain('$284.56') // closing: 1234.56 + 50 − 1000; pending does not reduce it
    expect(html).toContain('1–30')
  })

  it('signs as the property LLC and never as the firm', () => {
    const { html, subject } = renderStatementEmail(stmt(), header())
    expect(html).toContain('Test Park Holdings LLC')
    expect(`${html}${subject}`).not.toMatch(/oxford|ORA\b/i)
  })

  it('greets the contact, falling back to the tenant name', () => {
    expect(renderStatementEmail(stmt(), header()).html).toContain('Dear Pat Doe,')
    expect(renderStatementEmail(stmt(), header({ contactName: null })).html).toContain('Dear Acme Widgets Inc,')
    expect(renderStatementEmail(stmt(), header({ contactName: '  ' })).html).toContain('Dear Acme Widgets Inc,')
  })

  it('escapes every interpolated string', () => {
    const evil = '<script>alert(1)</script>&"\''
    const { html } = renderStatementEmail(stmt(), header({ tenantName: evil, contactName: null, propertyName: evil, entityLlc: evil, suite: evil, propertyAddress: evil }))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes charge descriptions', () => {
    const s = buildStatement({
      charges: [{ id: 'c', charge_date: '2026-10-01', due_date: '2026-10-01', type: 'other', description: '<img src=x onerror=1>', amountCents: 1 }],
      payments: [], start: '2026-10-01', end: '2026-10-31',
    })
    expect(renderStatementEmail(s, header()).html).not.toContain('<img')
  })

  it('subject strips control characters from property and suite', () => {
    const { subject } = renderStatementEmail(stmt(), header({ propertyName: 'Park\r\nBcc: x@y.z', suite: 'A\n1' }))
    expect(subject).not.toMatch(/[\r\n]/)
  })

  it('a credit balance says so instead of "amount due"', () => {
    const s = buildStatement({
      charges: [{ id: 'c', charge_date: '2026-10-01', due_date: '2026-10-01', type: 'rent', description: null, amountCents: 100 }],
      payments: [{ id: 'p', payment_date: '2026-10-02', method: 'wire', stripe_status: null, check_number: null, amountCents: 300 }],
      start: '2026-10-01', end: '2026-10-31',
    })
    const { html } = renderStatementEmail(s, header())
    expect(html).toMatch(/credit balance/i)
    expect(html).toContain('$2.00')
  })

  it('refuses to render without a signing entity', () => {
    expect(() => renderStatementEmail(stmt(), header({ entityLlc: '' }))).toThrow(/entity/)
  })
})
