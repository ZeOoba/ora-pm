import type { RentRollRow } from '../../types'

/** Rows of a per-property rent roll that are leases (vacant units have no lease_id). */
export function leaseRowsOf(rows: RentRollRow[] | undefined): RentRollRow[] {
  return (rows ?? []).filter((r) => r.lease_id)
}
