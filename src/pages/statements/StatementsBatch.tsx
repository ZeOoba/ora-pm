import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { QueryState } from '../../components/QueryState'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { DateInput } from '../../components/form/inputs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { formatCurrency } from '../../lib/format'
import { BLOCKER_LABELS, defaultRange, packetDrift, packetFilename, statementQuery, toDollars, validRange, type LeaseStatement } from './statement-view'

// /statements — statements for every lease with a balance as of the end date, and the Outlook
// draft packet. Nothing on this page sends mail: the packet becomes Outlook DRAFTS via
// scripts/stage-statement-drafts.ps1, and drafts are sent only after an explicit confirmation.
export function StatementsBatch() {
  const [start, setStart] = useState(defaultRange().start)
  const [end, setEnd] = useState(defaultRange().end)
  const [run, setRun] = useState<{ start: string; end: string } | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [packetNote, setPacketNote] = useState<{ text: string; warn: boolean } | null>(null)
  const range = validRange(start, end)

  const query = useQuery({
    queryKey: ['statements-batch', run?.start, run?.end],
    queryFn: () => api.get<{ data: LeaseStatement[] }>(`/statements/batch?${statementQuery(run!)}`),
    enabled: run !== null,
  })
  const rows = query.data?.data ?? []
  const ready = rows.filter(r => r.blockers.length === 0)
  const totalCents = rows.reduce((a, r) => a + r.statement.closingCents, 0)

  const downloadPacket = async () => {
    if (!run) return
    setDownloading(true)
    setDownloadError(null)
    setPacketNote(null)
    try {
      const { blob } = await api.download(`/statements/packet?${statementQuery(run)}`, packetFilename(run))
      // The packet is a fresh server read: tell the admin if it differs from the reviewed list.
      setPacketNote(packetDrift(JSON.parse(await blob.text()), rows))
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = packetFilename(run)
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      setDownloadError((e as Error).message)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div>
      <PageHeader title="Tenant Statements" subtitle="One statement per lease with a balance due as of the end date." />
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <label className="text-sm">Start<DateInput value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="text-sm">End<DateInput value={end} onChange={e => setEnd(e.target.value)} /></label>
        <Button type="button" disabled={range === null} onClick={() => setRun(range)}>Run statements</Button>
        {range === null && <p role="alert" className="text-sm text-status-danger">Start must be on or before end.</p>}
      </div>

      {run && (
        <QueryState
          query={query}
          isEmpty={(d) => (d as { data: LeaseStatement[] } | undefined)?.data.length === 0}
          empty={<EmptyState title="No balances due" message="No lease has a balance due as of the end date." />}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
            <p className="text-sm">
              <span className="font-medium">{rows.length}</span> statements · <span className="font-mono">{formatCurrency(toDollars(totalCents))}</span> due ·{' '}
              <span className="font-medium">{ready.length}</span> ready to stage · {rows.length - ready.length} blocked
            </p>
            <Button type="button" onClick={downloadPacket} disabled={downloading || ready.length === 0}>
              {downloading ? 'Preparing…' : 'Download Outlook draft packet'}
            </Button>
          </div>
          {downloadError && <p role="alert" className="mb-4 text-sm text-status-danger">{downloadError}</p>}
          {packetNote && (
            <p role="status" className={`mb-4 text-sm ${packetNote.warn ? 'text-status-warning' : 'text-status-neutral'}`}>{packetNote.text}</p>
          )}
          <p className="mb-4 text-xs text-status-neutral">
            The packet holds only the {ready.length} ready statements. Stage them with{' '}
            <code className="font-mono">scripts/stage-statement-drafts.ps1 -Packet &lt;file&gt;</code>, review the drafts in Outlook,
            then send only after explicit confirmation. Delete the packet file afterwards — it contains tenant contact details.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Suite</TableHead>
                  <TableHead className="text-right">Balance due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.lease_id}>
                    <TableCell className="font-medium">
                      <Link to={`/statements/lease/${r.lease_id}?${statementQuery(run)}`} className="text-navy underline-offset-2 hover:underline">{r.tenant_name}</Link>
                    </TableCell>
                    <TableCell className="text-status-neutral">{r.property_name}</TableCell>
                    <TableCell>{r.suite}</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(toDollars(r.statement.closingCents))}</TableCell>
                    <TableCell className={r.blockers.length ? 'text-status-warning' : 'text-status-neutral'}>
                      {r.blockers.length ? r.blockers.map(b => BLOCKER_LABELS[b]).join('; ') : 'Ready'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      )}
    </div>
  )
}
