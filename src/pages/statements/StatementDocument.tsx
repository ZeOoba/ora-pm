import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { formatCurrency, formatDate } from '../../lib/format'
import { AGING_COLUMNS, lineEffectCents, toDollars, type LeaseStatement } from './statement-view'

// The printable statement. Issued in the name of the property LLC (ORA Voice Register), never the
// firm; the app shell is hidden in print by the `data-statement-print` rule in src/index.css.
export function StatementDocument({ data }: { data: LeaseStatement }) {
  const s = data.statement
  const money = (cents: number) => formatCurrency(toDollars(cents))
  return (
    <article data-statement-print className="mx-auto max-w-3xl rounded-lg border border-border bg-card p-8 text-navy print:border-0 print:p-0">
      {/* A div, not <header>: the print rule hides every <header> (the app bar) while printing. */}
      <div className="mb-6 flex items-start justify-between gap-6">
        <div>
          <p className="font-display text-lg">{data.entity_llc ?? 'Owning LLC not set'}</p>
          <p className="text-sm text-status-neutral">{data.property_address || data.property_name}</p>
        </div>
        <div className="text-right">
          <h1 className="font-display text-2xl">Statement of Account</h1>
          <p className="text-sm text-status-neutral">{formatDate(s.start)} – {formatDate(s.end)}</p>
        </div>
      </div>

      <section className="mb-6 text-sm">
        <p className="font-medium">{data.tenant_name}</p>
        {data.contact_name && <p>Attn: {data.contact_name}</p>}
        <p className="text-status-neutral">{data.property_name}, Suite {data.suite}</p>
      </section>

      <section className="mb-6 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
        {([
          ['Opening balance', s.openingCents],
          ['Charges', s.chargesCents],
          ['Payments received', -s.paymentsCents],
          ...(s.forwardCents ? [['Balance forward from prior system', s.forwardCents]] : []),
          ['Closing balance', s.closingCents],
        ] as [string, number][]).map(([label, cents]) => (
          <div key={label as string}>
            <p className="text-xs uppercase text-status-neutral">{label}</p>
            <p className="font-mono text-base">{money(cents as number)}</p>
          </div>
        ))}
      </section>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>{formatDate(s.start)}</TableCell>
            <TableCell className="text-status-neutral">Opening balance</TableCell>
            <TableCell />
            <TableCell className="text-right font-mono">{money(s.openingCents)}</TableCell>
          </TableRow>
          {s.lines.map(l => (
            <TableRow key={`${l.kind}-${l.id}`}>
              <TableCell>{formatDate(l.date)}</TableCell>
              <TableCell>{l.label}</TableCell>
              <TableCell className="text-right font-mono">{lineEffectCents(l) < 0 ? `(${money(-lineEffectCents(l))})` : money(lineEffectCents(l))}</TableCell>
              <TableCell className="text-right font-mono">{money(l.balanceCents)}</TableCell>
            </TableRow>
          ))}
          {s.lines.length === 0 && (
            <TableRow><TableCell colSpan={4} className="py-4 text-center text-status-neutral">No charges or payments posted in this period.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>

      {s.pending.length > 0 && (
        <section className="mt-6 text-sm">
          <p className="font-medium">Payments not yet cleared</p>
          <p className="text-status-neutral">Shown for reference; not deducted from the balance until they clear.</p>
          <ul className="mt-1 font-mono">
            {s.pending.map(p => <li key={p.id}>{formatDate(p.date)} · ACH payment (processing) · {money(p.amountCents)}</li>)}
          </ul>
        </section>
      )}

      {s.closingCents > 0 && (
        <section className="mt-6 text-sm">
          <p className="mb-1 font-medium">Balance by age (as of {formatDate(s.end)})</p>
          <div className="grid grid-cols-5 gap-2">
            {AGING_COLUMNS.map(c => (
              <div key={c.key}>
                <p className="text-xs uppercase text-status-neutral">{c.label}</p>
                <p className="font-mono">{money(s.aging[c.key])}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="mt-8 text-base">
        {s.closingCents < 0
          ? <>Credit balance as of {formatDate(s.end)}: <strong className="font-mono">{money(-s.closingCents)}</strong></>
          : <>Balance due as of {formatDate(s.end)}: <strong className="font-mono">{money(s.closingCents)}</strong></>}
      </p>
    </article>
  )
}
