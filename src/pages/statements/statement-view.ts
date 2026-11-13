// View model for /api/statements (server/routes/statements.ts). Amounts arrive as integer cents.

export type StatementBlocker = 'missing_entity_llc' | 'missing_contact_email' | 'invalid_contact_email'

export interface StatementLine {
  date: string
  kind: 'charge' | 'payment' | 'balance_forward'
  id: string
  label: string
  amountCents: number // charges and payments: positive; balance_forward (from QuickBooks): signed
  balanceCents: number
}

/** What a line does to the balance, signed (mirrors server/lib/statement.ts). */
export function lineEffectCents(l: Pick<StatementLine, 'kind' | 'amountCents'>): number {
  return l.kind === 'payment' ? -l.amountCents : l.amountCents
}

export interface StatementAging {
  current: number
  d1_30: number
  d31_60: number
  d61_90: number
  d90_plus: number
  unallocated: number
}

export interface Statement {
  start: string
  end: string
  openingCents: number
  chargesCents: number
  paymentsCents: number
  forwardCents: number
  closingCents: number
  lines: StatementLine[]
  pending: { date: string; id: string; amountCents: number }[]
  pendingCents: number
  aging: StatementAging
}

export interface LeaseStatement {
  lease_id: string
  tenant_id: string
  tenant_name: string
  contact_name: string | null
  contact_email: string | null
  property_id: string
  property_name: string
  property_address: string
  suite: string
  entity_llc: string | null
  blockers: StatementBlocker[]
  statement: Statement
}

export const BLOCKER_LABELS: Record<StatementBlocker, string> = {
  missing_entity_llc: 'Property has no owning LLC',
  missing_contact_email: 'Tenant has no contact email',
  invalid_contact_email: 'Tenant contact email is invalid',
}

export const AGING_COLUMNS: { key: keyof StatementAging; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30' },
  { key: 'd31_60', label: '31–60' },
  { key: 'd61_90', label: '61–90' },
  { key: 'd90_plus', label: '90+' },
]

export const toDollars = (cents: number) => cents / 100

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** Default statement period: the first of the current month through today (local calendar). */
export function defaultRange(now: Date = new Date()): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = now.getFullYear()
  const m = pad(now.getMonth() + 1)
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${pad(now.getDate())}` }
}

/** A usable range for the API, or null (both ISO dates, start on or before end). */
export function validRange(start: string, end: string): { start: string; end: string } | null {
  if (!ISO.test(start) || !ISO.test(end) || start > end) return null
  return { start, end }
}

export function statementQuery(range: { start: string; end: string }): string {
  return `start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`
}

/**
 * The packet is a second server read, so a ledger write between "Run statements" and the download
 * can change it. Compare its draft count with the reviewed list's ready count.
 */
type PacketEntry = { lease_id: string; closing_cents: number }

export function packetDrift(
  packet: { items?: PacketEntry[]; skipped?: PacketEntry[] },
  reviewed: readonly LeaseStatement[],
): { text: string; warn: boolean } {
  const items = packet.items ?? []
  const skipped = packet.skipped ?? []
  // Compare lease-by-lease (id, closing amount, ready vs blocked) — a count alone misses one lease
  // leaving and another arriving, and any change of amount (REFUTE round 2).
  const key = (id: string, cents: number, ready: boolean) => `${id}|${cents}|${ready ? 'ready' : 'blocked'}`
  const got = new Set([...items.map(i => key(i.lease_id, i.closing_cents, true)), ...skipped.map(s => key(s.lease_id, s.closing_cents, false))])
  const want = new Set(reviewed.map(r => key(r.lease_id, r.statement.closingCents, r.blockers.length === 0)))
  const same = got.size === want.size && [...want].every(k => got.has(k))
  if (same) return { text: `Packet downloaded: ${items.length} drafts, ${skipped.length} skipped. It matches the list above.`, warn: false }
  return {
    text: 'The packet does not match the list above (a lease, amount or status changed since you ran statements). Delete the downloaded file, re-run statements and download again before staging.',
    warn: true,
  }
}

/** Packet file name, session-output convention: YYYY-MM-DD_Statements_DraftPacket_<start>_<end>.json */
export function packetFilename(range: { start: string; end: string }, today: Date = new Date()): string {
  const d = defaultRange(today).end
  return `${d}_Statements_DraftPacket_${range.start}_${range.end}.json`
}
