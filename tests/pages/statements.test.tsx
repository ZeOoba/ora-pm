import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { StatementDocument } from '../../src/pages/statements/StatementDocument'
import { defaultRange, packetDrift, packetFilename, validRange, statementQuery, type LeaseStatement } from '../../src/pages/statements/statement-view'

const data = (over: Partial<LeaseStatement['statement']> = {}): LeaseStatement => ({
  lease_id: 'l1', tenant_id: 't1', tenant_name: 'Acme Widgets Inc', contact_name: 'Pat Doe', contact_email: 'pat@acme.example',
  property_id: 'p1', property_name: 'Test Park', property_address: '100 Main St, Columbus, OH 43215', suite: 'B2',
  entity_llc: 'Test Park Holdings LLC', blockers: [],
  statement: {
    start: '2026-10-01', end: '2026-10-31', openingCents: 0, chargesCents: 128456, paymentsCents: 100000, forwardCents: 0, closingCents: 28456,
    lines: [
      { date: '2026-10-01', kind: 'charge', id: 'c1', label: 'Base rent', amountCents: 123456, balanceCents: 123456 },
      { date: '2026-10-06', kind: 'charge', id: 'c2', label: 'Late fee', amountCents: 5000, balanceCents: 128456 },
      { date: '2026-10-20', kind: 'payment', id: 'p1', label: 'Payment — check #1042', amountCents: 100000, balanceCents: 28456 },
    ],
    pending: [{ date: '2026-10-28', id: 'p2', amountCents: 20000 }], pendingCents: 20000,
    aging: { current: 0, d1_30: 28456, d31_60: 0, d61_90: 0, d90_plus: 0, unallocated: 0 },
    ...over,
  },
})

describe('statement-view helpers', () => {
  it('defaultRange is the first of the month through today', () => {
    expect(defaultRange(new Date(2026, 10, 9))).toEqual({ start: '2026-11-01', end: '2026-11-09' })
  })
  it('validRange rejects inverted or malformed ranges', () => {
    expect(validRange('2026-10-01', '2026-10-31')).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(validRange('2026-10-31', '2026-10-01')).toBeNull()
    expect(validRange('', '2026-10-01')).toBeNull()
  })
  it('statementQuery and packetFilename', () => {
    expect(statementQuery({ start: '2026-10-01', end: '2026-10-31' })).toBe('start=2026-10-01&end=2026-10-31')
    expect(packetFilename({ start: '2026-10-01', end: '2026-10-31' }, new Date(2026, 10, 9))).toBe('2026-11-09_Statements_DraftPacket_2026-10-01_2026-10-31.json')
  })
})

describe('packetDrift', () => {
  const row = (lease_id: string, closingCents: number, blocked = false): LeaseStatement =>
    ({ ...data({ closingCents }), lease_id, blockers: blocked ? ['missing_contact_email'] : [] })
  const reviewed = [row('a', 100), row('b', 200), row('c', 300, true)]
  const packet = { items: [{ lease_id: 'a', closing_cents: 100 }, { lease_id: 'b', closing_cents: 200 }], skipped: [{ lease_id: 'c', closing_cents: 300 }] }

  it('confirms a packet that matches the reviewed list', () => {
    expect(packetDrift(packet, reviewed).warn).toBe(false)
  })
  it('warns when one lease swaps for another at the same count', () => {
    expect(packetDrift({ ...packet, items: [packet.items[0], { lease_id: 'z', closing_cents: 200 }] }, reviewed).warn).toBe(true)
  })
  it('warns when an amount changed', () => {
    expect(packetDrift({ ...packet, items: [packet.items[0], { lease_id: 'b', closing_cents: 201 }] }, reviewed).warn).toBe(true)
  })
  it('warns when a lease moved between ready and blocked', () => {
    expect(packetDrift({ items: [...packet.items, { lease_id: 'c', closing_cents: 300 }], skipped: [] }, reviewed).warn).toBe(true)
  })
})

describe('StatementDocument', () => {
  it('renders issuer LLC, lines, pending memo, aging and balance due — never the firm name', () => {
    const html = renderToStaticMarkup(createElement(StatementDocument, { data: data() }))
    expect(html).toContain('Test Park Holdings LLC')
    expect(html).toContain('$1,234.56')
    expect(html).toContain('($1,000.00)')
    expect(html).toContain('Payments not yet cleared')
    expect(html).toContain('Balance due')
    expect(html).toContain('$284.56')
    expect(html).toContain('data-statement-print')
    expect(html).not.toMatch(/oxford/i)
    expect(html).not.toMatch(/<header/)
  })
  it('a credit balance reads as a credit, with no aging block', () => {
    const html = renderToStaticMarkup(createElement(StatementDocument, { data: data({ closingCents: -500, pending: [], pendingCents: 0 }) }))
    expect(html).toContain('Credit balance')
    expect(html).toContain('$5.00')
    expect(html).not.toContain('Balance by age')
  })
})
