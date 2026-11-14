import { describe, it, expect } from 'vitest'
import { normalizeName, parseAgingSummary, parseSignedCents, planBalanceForwards, type BfLease } from '../../server/lib/balance-forward-import'

// QuickBooks Desktop "A/R Aging Summary" exported to Excel and saved as CSV (title rows kept).
const csv = (rows: string[], asOf = 'As of November 12, 2026') => [
  ',Example Holdings LLC', ',A/R Aging Summary', `,"${asOf}"`, '',
  ',,Current,1 - 30,31 - 60,61 - 90,> 90,TOTAL',
  ...rows,
].join('\r\n')

const lease = (lease_id: string, tenant_name: string, app_cents: number, extra: Partial<BfLease> = {}): BfLease => ({
  lease_id, tenant_name, suite: 'A', property_name: '100 Example Dr', status: 'active', app_cents, pending_ach: false, live_forward: null, ...extra,
})

describe('parseSignedCents', () => {
  it('reads QuickBooks amounts, signed', () => {
    expect(parseSignedCents('1,234.56')).toBe(123456)
    expect(parseSignedCents('$1,234.5')).toBe(123450)
    expect(parseSignedCents('-12.00')).toBe(-1200)
    expect(parseSignedCents('(12.00)')).toBe(-1200)
    expect(parseSignedCents('0.00')).toBe(0)
    expect(parseSignedCents('')).toBe(0)
    for (const bad of ['12.345', 'abc', '1,,23.00', '--5']) expect(parseSignedCents(bad)).toBeNull()
  })
})

describe('normalizeName', () => {
  it('ignores case, punctuation, & and entity suffixes; keeps the job separator', () => {
    expect(normalizeName('Heritage Pool Supply, LLC')).toBe('heritage pool supply')
    expect(normalizeName('A & B Co.')).toBe(normalizeName('A and B'))
    expect(normalizeName('Acme Inc:Suite 4')).toBe('acme :suite 4') // the job matcher compares the part before ':', trimmed
  })
})

describe('parseAgingSummary', () => {
  it('customers, the TOTAL row and the As-of date; a job is named "<customer>:<job>"; subtotals skipped', () => {
    const p = parseAgingSummary(csv([
      'Heritage Pool Supply,,"1,000.00",500.00,0.00,0.00,0.00,"1,500.00"',
      'Bigco,,,,,,,',
      ',Unit 4,0.00,100.00,0.00,0.00,0.00,100.00',
      'Total Bigco,,0.00,100.00,0.00,0.00,0.00,100.00',
      'Credit Tenant,,-250.00,0.00,0.00,0.00,0.00,-250.00',
      'TOTAL,,"1,000.00",600.00,0.00,0.00,0.00,"1,350.00"',
    ]))
    expect(p.errors).toEqual([])
    expect(p.as_of).toBe('2026-11-12')
    expect(p.total_cents).toBe(135000)
    expect(p.customers.map((c) => [c.customer, c.cents])).toEqual([['Heritage Pool Supply', 150000], ['Bigco:Unit 4', 10000], ['Credit Tenant', -25000]])
  })

  it('fails when the rows do not add to TOTAL, TOTAL is missing, a customer repeats, or there is no header', () => {
    expect(parseAgingSummary(csv(['A,,1.00,0,0,0,0,1.00', 'TOTAL,,2.00,0,0,0,0,2.00'])).errors.join()).toMatch(/add up to \$1\.00 but the TOTAL row says \$2\.00/)
    expect(parseAgingSummary(csv(['A,,1.00,0,0,0,0,1.00'])).errors.join()).toMatch(/no TOTAL row/)
    expect(parseAgingSummary(csv(['A,,1,0,0,0,0,1.00', 'a,,1,0,0,0,0,1.00', 'TOTAL,,2,0,0,0,0,2.00'])).errors.join()).toMatch(/appears twice/)
    expect(parseAgingSummary('Customer,,Balance\r\nA,1.00').errors.join()).toMatch(/no header row/)
    expect(parseAgingSummary(csv(['A,,1,0,0,0,0,1.0x', 'TOTAL,,1,0,0,0,0,1.00'])).errors.join()).toMatch(/not an amount/)
  })
})

describe('planBalanceForwards', () => {
  const base = { as_of: '2026-11-12', today: '2026-11-13' }

  it('auto-matches by tenant name; adjustment = QuickBooks − app; a lease absent from the file is QuickBooks 0', () => {
    const plan = planBalanceForwards({
      ...base,
      leases: [lease('l1', 'Heritage Pool Supply', 3416000), lease('l2', 'Quiet Tenant', 120000), lease('l3', 'Square Tenant', 50000)],
      aging: parseAgingSummary(csv(['"Heritage Pool Supply, LLC",,0,0,0,0,"1,500.00","1,500.00"', 'Square Tenant,,500.00,0,0,0,0,500.00', 'TOTAL,,500,0,0,0,"1,500.00","2,000.00"'])),
    })
    expect(plan.errors).toEqual([])
    const by = Object.fromEntries(plan.rows.map((r) => [r.lease_id, r]))
    expect(by.l1).toMatchObject({ qb_cents: 150000, app_cents: 3416000, adjustment_cents: 150000 - 3416000, status: 'adjust', qb_source: 'file', qb_customers: ['Heritage Pool Supply, LLC'] })
    expect(by.l2).toMatchObject({ qb_cents: 0, adjustment_cents: -120000, status: 'adjust', qb_source: 'absent_from_file' })
    expect(by.l3).toMatchObject({ adjustment_cents: 0, status: 'no_change' })
    expect(plan.adjust_count).toBe(2)
    expect(plan.unmatched_cents).toBe(0)
  })

  it('a QuickBooks job ("Tenant:Job", or indented under its customer) matches its tenant (REFUTE-8 H2)', () => {
    const plan = planBalanceForwards({ ...base, leases: [lease('l1', 'Acme', 0)], aging: parseAgingSummary(csv(['Acme:Suite 4,,1.00,0,0,0,0,1.00', 'TOTAL,,1,0,0,0,0,1.00'])) })
    expect(plan.rows[0]).toMatchObject({ qb_cents: 100, qb_customers: ['Acme:Suite 4'] })
    const nested = planBalanceForwards({ ...base, leases: [lease('l1', 'Acme', 120000)], aging: parseAgingSummary(csv([
      'Acme,,,,,,,', ',Suite 100,0,0,"1,200.00",0,0,"1,200.00"', 'Total Acme,,0,0,"1,200.00",0,0,"1,200.00"', 'TOTAL,,0,0,"1,200.00",0,0,"1,200.00"'])) })
    expect(nested.errors).toEqual([])
    expect(nested.rows[0]).toMatchObject({ qb_cents: 120000, qb_customers: ['Acme:Suite 100'], status: 'no_change' })
  })

  it('a near-miss name is not auto-matched, and the plan refuses rather than zeroing the lease (REFUTE-8 H2)', () => {
    const plan = planBalanceForwards({ ...base, leases: [lease('l1', 'Acme Widgets, Inc.', 500000)],
      aging: parseAgingSummary(csv(['Acme Widget Inc,,"5,000.00",0,0,0,0,"5,000.00"', 'TOTAL,,"5,000.00",0,0,0,0,"5,000.00"'])) })
    expect(plan.errors.join()).toMatch(/"Acme Widget Inc" \(\$5,000\.00\) is not matched/)
    expect(plan.warnings.join()).toMatch(/1 lease has no QuickBooks customer and will be set to \$0 \(the app shows \$5,000\.00\)/)
  })

  it('an unmatched non-zero customer is an error until matched or explicitly left out (REFUTE-8 H2)', () => {
    const aging = parseAgingSummary(csv(['Former Tenant,,0,0,0,0,75.00,75.00', 'TOTAL,,0,0,0,0,75.00,75.00']))
    const leases = [lease('l1', 'Someone Else', 0)]
    const unmatched = planBalanceForwards({ ...base, leases, aging })
    expect(unmatched.errors.join()).toMatch(/"Former Tenant" \(\$75\.00\) is not matched to a lease/)
    const left = planBalanceForwards({ ...base, leases, aging, assign: { 'Former Tenant': '' } })
    expect(left.errors).toEqual([])
    expect(left.unmatched_cents).toBe(7500)
    expect(left.warnings.join()).toMatch(/\$75\.00 of the QuickBooks total is on customers not matched/)
    const assigned = planBalanceForwards({ ...base, leases, aging, assign: { 'Former Tenant': 'l1' } })
    expect(assigned.rows[0]).toMatchObject({ qb_cents: 7500, adjustment_cents: 7500 })
    expect(assigned.customers[0].how).toBe('assigned')
    expect(planBalanceForwards({ ...base, leases, aging, assign: { 'Former Tenant': 'nope' } }).errors.join()).toMatch(/not in this LLC/)
    expect(planBalanceForwards({ ...base, leases, aging, assign: { Ghost: 'l1' } }).errors.join()).toMatch(/not in the file/)
  })

  it('a customer matching two leases of one tenant is an error until assigned', () => {
    const plan = planBalanceForwards({ ...base, leases: [lease('l1', 'Two Suites', 0), lease('l2', 'Two Suites', 0)],
      aging: parseAgingSummary(csv(['Two Suites,,10.00,0,0,0,0,10.00', 'TOTAL,,10,0,0,0,0,10.00'])) })
    expect(plan.errors.join()).toMatch(/matches 2 leases/)
  })

  it('manual figures override the file; without a file the other leases are listed as needing a figure, never applied', () => {
    const leases = [lease('l1', 'A', 1000), lease('l2', 'B', 2000)]
    const noFile = planBalanceForwards({ ...base, leases, aging: null, manual: { l2: -500 } })
    expect(noFile.rows.map((r) => [r.lease_id, r.qb_source, r.status, r.adjustment_cents])).toEqual([['l1', 'none', 'no_figure', 0], ['l2', 'manual', 'adjust', -2500]])
    expect(noFile.adjust_count).toBe(1)
    expect(noFile.errors).toEqual([])
    const withFile = planBalanceForwards({ ...base, leases, aging: parseAgingSummary(csv(['A,,5.00,0,0,0,0,5.00', 'TOTAL,,5,0,0,0,0,5.00'])), manual: { l1: 0 } })
    expect(withFile.rows.find((r) => r.lease_id === 'l1')).toMatchObject({ qb_source: 'manual', qb_cents: 0, adjustment_cents: -1000 })
    expect(planBalanceForwards({ ...base, leases, aging: null, manual: { l1: 1.5 } }).errors.join()).toMatch(/whole cents/)
    expect(planBalanceForwards({ ...base, leases, aging: null }).adjust_count).toBe(0)
    expect(planBalanceForwards({ ...base, leases: [], aging: null }).errors.join()).toMatch(/no leases/)
  })

  it('refuses a future cut-off, a file dated otherwise, and a lease with ACH still processing; skips one already forwarded', () => {
    const aging = parseAgingSummary(csv(['A,,1,0,0,0,0,1.00', 'TOTAL,,1,0,0,0,0,1.00'], 'As of November 10, 2026'))
    const plan = planBalanceForwards({ ...base, aging, leases: [lease('l1', 'A', 0, { pending_ach: true }), lease('l2', 'B', 0, { live_forward: { amount_cents: 500, as_of: '2026-10-31' } })] })
    expect(plan.errors.join('\n')).toMatch(/report is "As of November 10, 2026" \(2026-11-10\) but the cut-off is 2026-11-12/)
    expect(plan.errors.join('\n')).toMatch(/still processing/)
    expect(plan.rows.find((r) => r.lease_id === 'l2')).toMatchObject({ status: 'has_forward' })
    expect(plan.adjust_count).toBe(0)
    expect(planBalanceForwards({ ...base, as_of: '2026-11-14', leases: [lease('l1', 'A', 0)], aging: null, manual: { l1: 1 } }).errors.join()).toMatch(/must be before today/)
    // REFUTE-8 R2: today itself is not a valid cut-off.
    expect(planBalanceForwards({ ...base, as_of: '2026-11-13', leases: [lease('l1', 'A', 0)], aging: null, manual: { l1: 1 } }).errors.join()).toMatch(/must be before today \(2026-11-13\)/)
    const undated = planBalanceForwards({ ...base, leases: [lease('l1', 'A', 0)], aging: parseAgingSummary(csv(['A,,1,0,0,0,0,1.00', 'TOTAL,,1,0,0,0,0,1.00'], '')) })
    expect(undated.errors.join()).toMatch(/does not show its report date/)
    const unreadable = planBalanceForwards({ ...base, leases: [lease('l1', 'A', 0)], aging: parseAgingSummary(csv(['A,,1,0,0,0,0,1.00', 'TOTAL,,1,0,0,0,0,1.00'], 'As of the 12th')) })
    expect(unreadable.errors.join()).toMatch(/could not read the report date/)
  })
})

describe('planBalanceForwards — the ledger tie-out (0032)', () => {
  const base = { as_of: '2026-11-12', today: '2026-11-13' }
  it('a lease whose LLC is tied out is blocked (never applied); others still plan', () => {
    const plan = planBalanceForwards({ ...base, aging: null, manual: { l1: 100, l2: 100 }, leases: [
      lease('l1', 'A', 0, { ledger: { tied_out_as_of: '2026-09-30', start_date: '2026-10-01' } }),
      lease('l2', 'B', 0, { ledger: { tied_out_as_of: null, start_date: '2027-01-01' } }),
    ] })
    expect(plan.rows.find((r) => r.lease_id === 'l1')).toMatchObject({ status: 'blocked', note: expect.stringMatching(/already tied out in the ledger as of 2026-09-30/) })
    expect(plan.rows.find((r) => r.lease_id === 'l2')).toMatchObject({ status: 'adjust' })
    expect(plan.adjust_count).toBe(1)
  })
  it('warns when the cut-off is on or after a ledger start date (the tie-out would refuse it)', () => {
    const plan = planBalanceForwards({ ...base, aging: null, manual: { l1: 100 }, leases: [lease('l1', 'A', 0, { ledger: { tied_out_as_of: null, start_date: '2026-11-01' } })] })
    expect(plan.warnings.join()).toMatch(/on or after the ledger start date 2026-11-01/)
    const fine = planBalanceForwards({ ...base, aging: null, manual: { l1: 100 }, leases: [lease('l1', 'A', 0, { ledger: { tied_out_as_of: null, start_date: '2027-01-01' } })] })
    expect(fine.warnings.join()).not.toMatch(/ledger start date/)
  })
})

describe('planBalanceForwards — REFUTE-9 F10/F11', () => {
  const base = { as_of: '2026-11-12', today: '2026-11-13' }
  it('F10: a forward in a tied-out LLC is not offered "void it to import again"', () => {
    const plan = planBalanceForwards({ ...base, aging: null, manual: { l1: 100 }, leases: [
      lease('l1', 'A', 0, { live_forward: { amount_cents: 5000, as_of: '2026-05-31' }, ledger: { tied_out_as_of: '2026-05-31', start_date: '2026-06-01' } })] })
    expect(plan.rows[0].note).toMatch(/can no longer be voided or re-imported/)
    expect(plan.rows[0].note).not.toMatch(/void it to import again/)
  })
  it('F11: the start-date warning considers only leases being adjusted', () => {
    const plan = planBalanceForwards({ ...base, as_of: '2026-06-30', today: '2026-11-13', aging: null, manual: { t: 100, o: 100 }, leases: [
      lease('t', 'Tied', 0, { ledger: { tied_out_as_of: '2026-05-31', start_date: '2026-06-01' } }),
      lease('o', 'Open', 0, { ledger: { tied_out_as_of: null, start_date: '2026-08-01' } })] })
    expect(plan.adjust_count).toBe(1)
    expect(plan.warnings.join()).not.toMatch(/ledger start date/)
  })
})
