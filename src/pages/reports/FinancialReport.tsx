import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router'
import { Printer, SlidersHorizontal, Download } from 'lucide-react'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { QueryState } from '../../components/QueryState'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { DateInput, Select } from '../../components/form/inputs'
import { csvFilename, downloadCsv, toCsv } from '../../components/data-table/csv'
import { DATE_PRESETS } from '../../lib/date-range'
import { parseReportFilters } from '../../lib/report-filters'
import { formatCurrency, formatDate } from '../../lib/format'
import { cashFlowRows, incomeStatementRows, monthlyRows, type Detail, type RowKind } from './statement-rows'
import type { FinancialsResponse, MonthlyIncomeStatementResponse } from '../../lib/report-types'
import type { Property } from '../../types'

const KINDS = {
  'income-statement': { title: 'Income Statement', basis: 'Billed basis: non-voided charges by charge date; expenses by expense date. Security deposits are excluded from income.' },
  'income-statement-12-month': { title: 'Income Statement - 12 Month', basis: 'Billed basis: non-voided charges by charge date; expenses by expense date. Twelve months ending in the month of the selected end date.' },
  'cash-flow': { title: 'Cash Flow', basis: 'Cash basis: payments the AR ledger counts as received (settled ACH, check, wire, other); recorded expenses as cash out.' },
} as const
type Kind = keyof typeof KINDS
const isKind = (k: string | undefined): k is Kind => !!k && k in KINDS

const ROW_CLASS: Record<RowKind, string> = {
  section: 'font-medium text-foreground',
  line: 'pl-6 text-foreground',
  total: 'pl-3 font-semibold text-foreground border-t border-border',
  grand: 'font-semibold text-navy',
}

const money = (v: number | null) => (v === null ? '' : formatCurrency(v))
const pctText = (v: number | null) => (v === null ? '' : v.toFixed(2))
const monthLabel = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

export function FinancialReport() {
  const { kind } = useParams()
  const [sp, setSp] = useSearchParams()
  const [customizing, setCustomizing] = useState(false)
  const [showDetails, setShowDetails] = useState(true)

  const properties = useQuery({
    queryKey: ['properties', 'all-for-filter'],
    queryFn: () => api.listAll<Property>('/properties', { sort: 'name', dir: 'asc' }),
  })
  const dates = parseReportFilters(sp)
  const selectedIds = (sp.get('properties') ?? '').split(',').filter(Boolean)
  const detail: Detail = sp.get('detail') === 'summary' ? 'summary' : 'detail'
  const params = new URLSearchParams({ from: dates.range.from, to: dates.range.to })
  if (selectedIds.length) params.set('property_ids', selectedIds.join(','))
  const through = dates.range.to.slice(0, 7)

  const valid = isKind(kind)
  const financials = useQuery({
    queryKey: ['financials', params.toString()],
    queryFn: () => api.get<FinancialsResponse>(`/reports/financials?${params}`),
    enabled: valid && kind !== 'income-statement-12-month',
  })
  const monthly = useQuery({
    queryKey: ['income-statement-12mo', through, selectedIds.join(',')],
    queryFn: () => api.get<MonthlyIncomeStatementResponse>(
      `/reports/income-statement-12mo?through=${through}${selectedIds.length ? `&property_ids=${selectedIds.join(',')}` : ''}`),
    enabled: valid && kind === 'income-statement-12-month',
  })

  if (!valid) {
    return <EmptyState title="Report not found" message="Pick a report from the library." action={<Link to="/reports" className="text-primary hover:underline">All reports</Link>} />
  }
  const meta = KINDS[kind]
  const names = (properties.data ?? []).filter((p) => selectedIds.includes(p.id)).map((p) => p.name)
  const propertyLabel = selectedIds.length === 0 ? 'All properties' : names.length ? names.join(', ') : `${selectedIds.length} selected`

  const apply = (next: { ids: string[]; preset: string; from: string; to: string; detail: Detail }) => {
    const p = new URLSearchParams()
    if (next.ids.length) p.set('properties', next.ids.join(','))
    p.set('range', next.preset)
    if (next.preset === 'custom') { p.set('from', next.from); p.set('to', next.to) }
    if (next.detail === 'summary') p.set('detail', 'summary')
    setSp(p, { replace: true })
    setCustomizing(false)
  }

  const twelve = kind === 'income-statement-12-month'
  const stmtRows = !twelve && financials.data
    ? (kind === 'cash-flow'
        ? cashFlowRows(financials.data.cash_flow.period, financials.data.cash_flow.fytd, detail)
        : incomeStatementRows(financials.data.income_statement.period, financials.data.income_statement.fytd, detail))
    : []
  const mRows = twelve && monthly.data ? monthlyRows(monthly.data, detail) : []

  const exportCsv = () => {
    if (twelve && monthly.data) {
      const cols = [...monthly.data.months.map(monthLabel), 'Total']
      downloadCsv(csvFilename(kind), toCsv(mRows, [
        { header: 'Account Name', accessor: (r) => r.label },
        ...cols.map((c, i) => ({ header: c, accessor: (r: (typeof mRows)[number]) => r.values[i] })),
      ]))
    } else {
      downloadCsv(csvFilename(kind), toCsv(stmtRows, [
        { header: 'Account Name', accessor: (r) => r.label },
        { header: 'Selected Period', accessor: (r) => r.period },
        { header: '% of Selected Period', accessor: (r) => r.periodPct },
        { header: 'Fiscal Year To Date', accessor: (r) => r.fytd },
        { header: '% of Fiscal Year To Date', accessor: (r) => r.fytdPct },
      ]))
    }
  }

  const loaded = twelve ? !!monthly.data : !!financials.data
  return (
    <div>
      <PageHeader
        title={meta.title}
        action={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="ghost" onClick={() => setCustomizing(true)}><SlidersHorizontal className="mr-1.5 size-4" />Customize</Button>
            <Button variant="ghost" onClick={exportCsv} disabled={!loaded}><Download className="mr-1.5 size-4" />Export CSV</Button>
            <Button variant="ghost" onClick={() => window.print()} disabled={!loaded}><Printer className="mr-1.5 size-4" />Print</Button>
          </div>
        }
      />
      <div className="mb-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <button type="button" className="text-primary hover:underline print:hidden" onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
        {showDetails && (
          <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[10rem_1fr]">
            <dt className="font-medium">Properties</dt><dd>{propertyLabel}</dd>
            <dt className="font-medium">Date Range</dt>
            <dd>{twelve && monthly.data ? `${monthLabel(monthly.data.months[0])} – ${monthLabel(monthly.data.months[11])}` : `${formatDate(dates.range.from)} to ${formatDate(dates.range.to)}`}</dd>
            {!twelve && financials.data && (<><dt className="font-medium">Fiscal Year To Date</dt><dd>{formatDate(financials.data.fytd_range.from)} to {formatDate(financials.data.fytd_range.to)}</dd></>)}
            <dt className="font-medium">Level of Detail</dt><dd>{detail === 'detail' ? 'Detail View' : 'Summary View'}</dd>
            <dt className="font-medium">Basis</dt><dd className="text-muted-foreground">{meta.basis} Not a general ledger.</dd>
          </dl>
        )}
      </div>

      <QueryState query={twelve ? monthly : financials}>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          {twelve ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-card">Account Name</TableHead>
                  {(monthly.data?.months ?? []).map((m) => <TableHead key={m} className="text-right whitespace-nowrap">{monthLabel(m)}</TableHead>)}
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mRows.map((r, i) => (
                  <TableRow key={`${r.label}-${i}`}>
                    <TableCell className={`sticky left-0 bg-card whitespace-nowrap ${ROW_CLASS[r.kind]}`}>{r.label}</TableCell>
                    {r.values.map((v, j) => <TableCell key={j} className="text-right font-mono whitespace-nowrap">{money(v)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account Name</TableHead>
                  <TableHead className="text-right">Selected Period</TableHead>
                  <TableHead className="text-right">% of Selected Period</TableHead>
                  <TableHead className="text-right">Fiscal Year To Date</TableHead>
                  <TableHead className="text-right">% of Fiscal Year To Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stmtRows.map((r, i) => (
                  <TableRow key={`${r.label}-${i}`}>
                    <TableCell className={ROW_CLASS[r.kind]}>{r.label}</TableCell>
                    <TableCell className="text-right font-mono">{money(r.period)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{pctText(r.periodPct)}</TableCell>
                    <TableCell className="text-right font-mono">{money(r.fytd)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{pctText(r.fytdPct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        {!twelve && financials.data && (() => {
          const notes: string[] = []
          const dep = financials.data.income_statement.period.excluded.security_deposits
          const pending = financials.data.cash_flow.period.pending_ach
          if (kind === 'income-statement' && dep > 0) notes.push(`${formatCurrency(dep)} of security deposits billed in the period are excluded from income.`)
          if (kind === 'cash-flow' && pending > 0) notes.push(`${formatCurrency(pending)} of ACH payments are pending or processing and not counted.`)
          return notes.length ? <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null
        })()}
      </QueryState>

      <CustomizeDialog
        open={customizing}
        onOpenChange={setCustomizing}
        properties={properties.data ?? []}
        initial={{ ids: selectedIds, preset: dates.preset, from: dates.range.from, to: dates.range.to, detail }}
        onApply={apply}
      />
    </div>
  )
}

type Draft = { ids: string[]; preset: string; from: string; to: string; detail: Detail }

function CustomizeDialog({ open, onOpenChange, properties, initial, onApply }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  properties: Property[]
  initial: Draft
  onApply: (d: Draft) => void
}) {
  // Empty selection in the URL means "all": show every box checked.
  const [draft, setDraft] = useState<Draft>(initial)
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setDraft({ ...initial, ids: initial.ids.length ? initial.ids : properties.map((p) => p.id) })
  }
  const mode = draft.preset === 'custom' ? 'custom' : 'preset'
  const toggle = (id: string) =>
    setDraft((d) => ({ ...d, ids: d.ids.includes(id) ? d.ids.filter((x) => x !== id) : [...d.ids, id] }))
  const invalid = draft.ids.length === 0 || (mode === 'custom' && (!draft.from || !draft.to || draft.from > draft.to))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Customize Report</DialogTitle>
          <DialogDescription>Choose properties, a date range and the level of detail.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          <fieldset>
            <legend className="mb-1 text-muted-foreground">Properties</legend>
            <div className="mb-1 flex gap-3 text-xs">
              <span>Select:</span>
              <button type="button" className="text-primary hover:underline" onClick={() => setDraft((d) => ({ ...d, ids: properties.map((p) => p.id) }))}>All</button>
              <button type="button" className="text-primary hover:underline" onClick={() => setDraft((d) => ({ ...d, ids: [] }))}>None</button>
              <span className="text-muted-foreground">{draft.ids.length} items selected</span>
            </div>
            <div className="max-h-44 overflow-y-auto rounded-md border border-border p-2">
              {properties.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 py-0.5">
                  <input type="checkbox" checked={draft.ids.includes(p.id)} onChange={() => toggle(p.id)} className="accent-navy" />
                  {p.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-muted-foreground">Date Range</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === 'custom'} className="accent-navy"
                onChange={() => setDraft((d) => ({ ...d, preset: 'custom' }))} />
              <DateInput aria-label="From" value={draft.from} disabled={mode !== 'custom'} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
              <span>to</span>
              <DateInput aria-label="To" value={draft.to} disabled={mode !== 'custom'} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === 'preset'} className="accent-navy"
                onChange={() => setDraft((d) => ({ ...d, preset: 'mtd' }))} />
              <Select aria-label="Preset" value={mode === 'preset' ? draft.preset : 'mtd'} disabled={mode !== 'preset'}
                onChange={(e) => setDraft((d) => ({ ...d, preset: e.target.value }))}>
                {DATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Select>
            </label>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-muted-foreground">Level of Detail</legend>
            <div className="flex gap-4">
              {(['detail', 'summary'] as const).map((d) => (
                <label key={d} className="flex items-center gap-2">
                  <input type="radio" name="detail" checked={draft.detail === d} className="accent-navy" onChange={() => setDraft((x) => ({ ...x, detail: d }))} />
                  {d === 'detail' ? 'Detail View' : 'Summary View'}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <DialogFooter>
          <Button disabled={invalid} onClick={() => {
            // Every box checked = all properties (keeps the URL short and follows new properties).
            const all = draft.ids.length === properties.length
            onApply({ ...draft, ids: all ? [] : draft.ids })
          }}>Update</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
