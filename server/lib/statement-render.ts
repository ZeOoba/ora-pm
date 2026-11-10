// Statement → Outlook draft (subject + HTML body). Pure string building; every interpolated value
// is escaped. Signed as the property LLC (ORA Voice Register: landlord mail is signed by the
// property-owning entity, never the firm), so a statement with no entity_llc cannot be rendered —
// the route reports it as a blocker instead of staging it.
import type { Statement } from './statement'

export interface StatementHeader {
  leaseId: string
  tenantName: string
  contactName: string | null
  propertyName: string
  propertyAddress: string
  suite: string
  entityLlc: string
}

export function formatCents(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100).toLocaleString('en-US')
  const s = `$${dollars}.${String(abs % 100).padStart(2, '0')}`
  return neg ? `-${s}` : s
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Header-safe: collapse every control character (CR/LF included) to a space.
function oneLine(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function usDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y}`
}

const AGING_LABELS: [keyof Statement['aging'], string][] = [
  ['current', 'Current'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', 'Over 90 days'],
]

const TD = 'style="padding:4px 8px;border-bottom:1px solid #e5e5e5"'
const TDR = 'style="padding:4px 8px;border-bottom:1px solid #e5e5e5;text-align:right"'
const TH = 'style="padding:4px 8px;border-bottom:2px solid #1f2a44;text-align:left"'
const THR = 'style="padding:4px 8px;border-bottom:2px solid #1f2a44;text-align:right"'

export function renderStatementEmail(s: Statement, h: StatementHeader): { subject: string; html: string } {
  const entity = h.entityLlc.trim()
  if (!entity) throw new Error(`lease ${h.leaseId}: no signing entity (properties.entity_llc) — cannot render statement`)
  const period = `${usDate(s.start)} to ${usDate(s.end)}`
  const subject = oneLine(`Statement of Account — ${oneLine(h.propertyName)}, Suite ${oneLine(h.suite)} — ${period}`)
  const greeting = h.contactName?.trim() || h.tenantName

  const activity = s.lines.length === 0
    ? `<tr><td ${TD} colspan="4">No charges or payments posted in this period.</td></tr>`
    : s.lines.map(l => `<tr><td ${TD}>${usDate(l.date)}</td><td ${TD}>${esc(l.label)}</td>`
      + `<td ${TDR}>${l.kind === 'payment' ? `(${formatCents(l.amountCents)})` : formatCents(l.amountCents)}</td>`
      + `<td ${TDR}>${formatCents(l.balanceCents)}</td></tr>`).join('')

  const pending = s.pending.length === 0 ? '' : `
<p style="margin:16px 0 4px"><strong>Payments not yet cleared</strong> — shown for reference; not deducted from the balance above until they clear.</p>
<table style="border-collapse:collapse;font-size:14px">${s.pending.map(p =>
    `<tr><td ${TD}>${usDate(p.date)}</td><td ${TD}>ACH payment (processing)</td><td ${TDR}>${formatCents(p.amountCents)}</td></tr>`).join('')}</table>`

  const aging = s.closingCents > 0 ? `
<p style="margin:16px 0 4px"><strong>Balance by age</strong> (as of ${usDate(s.end)})</p>
<table style="border-collapse:collapse;font-size:14px"><tr>${AGING_LABELS.map(([, l]) => `<th ${THR}>${l}</th>`).join('')}</tr>
<tr>${AGING_LABELS.map(([k]) => `<td ${TDR}>${formatCents(s.aging[k])}</td>`).join('')}</tr></table>` : ''

  const closingLine = s.closingCents < 0
    ? `Credit balance as of ${usDate(s.end)}: <strong>${formatCents(-s.closingCents)}</strong>`
    : `Balance due as of ${usDate(s.end)}: <strong>${formatCents(s.closingCents)}</strong>`

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a">
<p>Dear ${esc(greeting)},</p>
<p>Below is your statement of account for ${esc(h.propertyAddress)}, Suite ${esc(h.suite)}, for ${period}.</p>
<table style="border-collapse:collapse;font-size:14px;margin:8px 0">
<tr><td ${TD}>Opening balance (${usDate(s.start)})</td><td ${TDR}>${formatCents(s.openingCents)}</td></tr>
<tr><td ${TD}>Charges</td><td ${TDR}>${formatCents(s.chargesCents)}</td></tr>
<tr><td ${TD}>Payments received</td><td ${TDR}>(${formatCents(s.paymentsCents)})</td></tr>
<tr><td ${TD}><strong>Closing balance (${usDate(s.end)})</strong></td><td ${TDR}><strong>${formatCents(s.closingCents)}</strong></td></tr>
</table>
<p style="margin:16px 0 4px"><strong>Activity</strong></p>
<table style="border-collapse:collapse;font-size:14px">
<tr><th ${TH}>Date</th><th ${TH}>Description</th><th ${THR}>Amount</th><th ${THR}>Balance</th></tr>
${activity}
</table>${pending}${aging}
<p style="margin-top:16px">${closingLine}</p>
<p>Your charges and payment history are also available in the tenant portal. Please reply to this email with any questions about this statement.</p>
<p>Sincerely,<br>${esc(entity)}</p>
</div>`
  return { subject, html }
}
