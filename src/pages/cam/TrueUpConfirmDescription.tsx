import { formatCurrency } from '../../lib/format'

type TrueUpRow = {
  true_up_amount: number
  reconciliation_year: number
  leases?: { tenants?: { name: string } | null } | null
}

// Confirm-dialog copy for CAM "Approve & Bill". Mirrors POST /cam/:id/approve exactly:
//   < 0  -> marks billed, credit flagged for manual handling, nothing posted;
//   === 0 -> the server no-ops (balanced), nothing posted;
//   > 0  -> posts a true-up charge to the tenant ledger.
export function TrueUpConfirmDescription({ row }: { row: TrueUpRow }) {
  const amount = row.true_up_amount
  if (amount < 0) {
    return (
      <>
        {row.leases?.tenants?.name ?? 'This tenant'} ({row.reconciliation_year}) is owed a credit of{' '}
        <span className="font-mono">{formatCurrency(Math.abs(amount))}</span>. Approving marks it billed
        and flags the credit for manual handling — nothing is posted to the ledger.
      </>
    )
  }
  if (amount === 0) {
    return (
      <>
        {row.leases?.tenants?.name ?? 'This tenant'} ({row.reconciliation_year}) is balanced: there is no
        true-up, so nothing will be posted to the tenant ledger.
      </>
    )
  }
  return (
    <>
      Posts a <span className="font-mono">{formatCurrency(amount)}</span> true-up charge for{' '}
      {row.leases?.tenants?.name ?? 'this tenant'} ({row.reconciliation_year}) to the tenant ledger.
    </>
  )
}
