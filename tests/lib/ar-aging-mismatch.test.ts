import { describe, it, expect } from 'vitest'
import { findChargeTotalMismatch, type AllocationCharge } from '../../server/lib/ar-aging'

// ar_ledger.total_charged = Σ non-voided charges from the SAME snapshot as the ledger row, so the
// separately-fetched charges must sum to it; any difference means the two reads straddled a write
// (or the charge read was truncated).
const ch = (id: string, amountCents: number): AllocationCharge => ({ id, due_date: '2026-10-01', amountCents })
const map = (e: [string, AllocationCharge[]][]) => new Map(e)

describe('findChargeTotalMismatch', () => {
  it('returns null when every lease ties (numbers and NUMERIC strings)', () => {
    const rows = [{ lease_id: 'l1', total_charged: 300 }, { lease_id: 'l2', total_charged: '0.30' }]
    expect(findChargeTotalMismatch(rows, map([['l1', [ch('a', 100_00), ch('b', 200_00)]], ['l2', [ch('c', 30)]]]))).toBeNull()
  })

  it('a lease with no fetched charges ties only when total_charged is 0', () => {
    expect(findChargeTotalMismatch([{ lease_id: 'l1', total_charged: 0 }], new Map())).toBeNull()
    expect(findChargeTotalMismatch([{ lease_id: 'l1', total_charged: 50 }], new Map()))
      .toEqual({ leaseId: 'l1', ledgerCents: 5000, chargeCents: 0 })
  })

  it('reports the FIRST mismatching lease with both cent values', () => {
    const rows = [{ lease_id: 'l1', total_charged: 100 }, { lease_id: 'l2', total_charged: 500 }, { lease_id: 'l3', total_charged: 9 }]
    const m = findChargeTotalMismatch(rows, map([['l1', [ch('a', 100_00)]], ['l2', [ch('b', 400_00)]], ['l3', []]]))
    expect(m).toEqual({ leaseId: 'l2', ledgerCents: 50_000, chargeCents: 40_000 })
  })

  it('detects a 1-cent difference', () => {
    expect(findChargeTotalMismatch([{ lease_id: 'l1', total_charged: 10 }], map([['l1', [ch('a', 999)]]])))
      .toEqual({ leaseId: 'l1', ledgerCents: 1000, chargeCents: 999 })
  })

  it('a non-numeric total_charged is a mismatch (ledgerCents null), never a silent pass', () => {
    expect(findChargeTotalMismatch([{ lease_id: 'l1', total_charged: null }], new Map()))
      .toEqual({ leaseId: 'l1', ledgerCents: null, chargeCents: 0 })
  })
})
