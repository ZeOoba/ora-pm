import { describe, it, expect } from 'vitest'
import { leaseRowsOf } from '../../src/pages/properties/property-leases'
import type { RentRollRow } from '../../src/types'

const row = (over: Partial<RentRollRow>): RentRollRow => ({
  property_id: 'p1', property_name: 'Acme Test Park', unit_id: 'u', suite: '1', sf: 1000,
  unit_status: 'occupied', tenant_id: null, tenant_name: null,
  lease_id: 'l1', start_date: '2024-01-01', end_date: '2027-06-30',
  lease_status: 'active', rent_type: 'nnn',
  ...over,
} as RentRollRow)

describe('leaseRowsOf (per-property rent roll -> lease rows)', () => {
  it('keeps only rows that carry a lease_id (vacant units are not leases)', () => {
    const rows = [row({ unit_id: 'a' }), row({ unit_id: 'b', lease_id: null, unit_status: 'vacant' })]
    expect(leaseRowsOf(rows).map((r) => r.unit_id)).toEqual(['a'])
  })
  it('does not re-filter by property (the endpoint already scoped it) and tolerates undefined', () => {
    expect(leaseRowsOf([row({ property_id: 'other' })])).toHaveLength(1)
    expect(leaseRowsOf(undefined)).toEqual([])
  })
})
