// Books › Balance forward: view helpers. The server plans and the database decides; these only
// read what the user types and label what the server returns.

export type BfRowStatus = 'adjust' | 'no_change' | 'has_forward' | 'blocked' | 'no_figure'

export interface BfPlanRow {
  lease_id: string
  tenant_name: string
  suite: string | null
  property_name: string
  lease_status: string
  qb_customers: string[]
  qb_source: 'file' | 'manual' | 'absent_from_file' | 'none'
  qb_cents: number
  app_cents: number
  adjustment_cents: number
  status: BfRowStatus
  note: string | null
}

export interface BfCustomer { row: number; customer: string; cents: number; lease_id: string | null; how: 'auto' | 'assigned' | 'unmatched' }

export interface BfPlan {
  llc: string
  as_of: string
  customers: BfCustomer[]
  file_total_cents: number | null
  unmatched_cents: number
  rows: BfPlanRow[]
  adjust_count: number
  errors: string[]
  warnings: string[]
  plan_hash: string
  applied: boolean
  written: { id: string }[]
}

export interface BalanceForwardRecord {
  id: string
  lease_id: string
  as_of: string
  qb_balance: number | string
  app_balance: number | string
  amount: number | string
  qb_customer: string | null
  source: string
  source_ref: string | null
  created_by: string
  created_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  tenant_name: string | null
  suite: string | null
  property_name: string | null
  /** 0032: counted in the ledger's AR tie-out, so it can no longer be voided. */
  counted_at_tieout?: boolean
}

export const STATUS_LABELS: Record<BfRowStatus, string> = {
  adjust: 'Will adjust',
  no_change: 'Matches',
  has_forward: 'Already forwarded',
  blocked: 'Blocked',
  no_figure: 'No QuickBooks figure',
}

export const SOURCE_LABELS: Record<BfPlanRow['qb_source'], string> = {
  file: 'From the file',
  manual: 'Entered by hand',
  absent_from_file: 'Not in the file (0)',
  none: 'Type the QuickBooks balance',
}

/** What the user typed as a QuickBooks balance → signed cents; null when it is not an amount. */
export function parseDollarsInput(raw: string): number | null {
  let v = raw.trim().replace(/\s+/g, '')
  if (v === '') return null
  let sign = 1
  const paren = /^\((.*)\)$/.exec(v)
  if (paren) { sign = -1; v = paren[1] }
  if (v.startsWith('-') || v.startsWith('−')) { sign = -sign; v = v.slice(1) }
  v = v.replace(/^\$/, '')
  const m = /^((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?$/.exec(v)
  if (!m) return null
  const cents = Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? sign * cents : null
}

/** The day before a YYYY-MM-DD date: the latest allowed cut-off (it must be before today). */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export const BF_FILE_MAX_BYTES = 1024 * 1024

export function agingFileProblem(file: { name: string; size: number }): string | null {
  if (!/\.csv$/i.test(file.name)) return 'Save the A/R Aging Summary from Excel as CSV (.csv) and choose that file.'
  if (file.size > BF_FILE_MAX_BYTES) return 'That file is larger than 1 MB; an A/R Aging Summary is far smaller.'
  return null
}
