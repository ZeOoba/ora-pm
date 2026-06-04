import { describe, it, expect } from 'vitest'
import type { Property, Lease, Charge, ARLedgerRow, RentRollRow, CriticalDateRow } from '../../src/types'

describe('domain types', () => {
  it('Property type has required fields', () => {
    const p: Property = {
      id: 'uuid', name: '9050 Red Branch', address: '9050 Red Branch Rd',
      city: 'Columbia', state: 'MD', zip: '21045',
      total_sf: 20000, property_type: 'industrial', entity_llc: 'ORA LLC',
      notes: null, created_at: '2026-01-01T00:00:00Z',
    }
    expect(p.name).toBe('9050 Red Branch')
  })

  it('Charge type enum includes all utility types', () => {
    const types: Charge['type'][] = [
      'rent','cam_estimate','utility_water','utility_gas','utility_electric',
      'utility_other','percentage_rent','cam_true_up','late_fee','security_deposit','other'
    ]
    expect(types).toHaveLength(11)
  })

  it('ARLedgerRow has balance, total_charged, total_paid', () => {
    const row: ARLedgerRow = {
      lease_id: 'l1', tenant_id: 't1', unit_id: 'u1',
      tenant_name: 'Acme', property_id: 'p1', suite: 'A1',
      total_charged: 5000, total_paid: 4000, balance: 1000,
    }
    expect(row.balance).toBe(1000)
  })

  it('Lease type has required financial fields', () => {
    const l: Lease = {
      id: 'l1', tenant_id: 't1', unit_id: 'u1',
      start_date: '2026-01-01', end_date: '2027-01-01',
      status: 'active', rent_type: 'nnn',
      base_rent_monthly: 3000, cam_estimate_monthly: 300, security_deposit: 6000,
      expense_stop_amount: null, ti_allowance: null, ti_reimbursement_schedule: null,
      percentage_rent_terms: null, options: null, notes: null,
      created_at: '2026-01-01T00:00:00Z',
    }
    expect(l.base_rent_monthly).toBe(3000)
  })

  it('RentRollRow has rent and CAM fields', () => {
    const r: RentRollRow = {
      property_id: 'p1', property_name: '9050 Red Branch', unit_id: 'u1',
      suite: 'A1', sf: 5000, unit_status: 'occupied',
      tenant_id: 't1', tenant_name: 'Acme',
      lease_id: 'l1', start_date: '2026-01-01', end_date: '2027-01-01',
      lease_status: 'active', rent_type: 'nnn',
      base_rent_monthly: 3000, cam_estimate_monthly: 300,
      total_monthly: 3300, rent_psf_annual: 7.2,
    }
    expect(r.total_monthly).toBe(3300)
  })

  it('CriticalDateRow has urgency and days_until fields', () => {
    const c: CriticalDateRow = {
      date_type: 'lease_expiration', reference_id: 'l1',
      tenant_name: 'Acme', property_name: '9050 Red Branch', suite: 'A1',
      critical_date: '2027-01-01', days_until: 90, urgency: 'notice',
    }
    expect(c.urgency).toBe('notice')
  })
})
