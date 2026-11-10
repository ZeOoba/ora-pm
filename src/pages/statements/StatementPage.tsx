import { useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { QueryState } from '../../components/QueryState'
import { Button } from '../../components/ui/Button'
import { DateInput } from '../../components/form/inputs'
import { StatementDocument } from './StatementDocument'
import { BLOCKER_LABELS, defaultRange, statementQuery, validRange, type LeaseStatement } from './statement-view'

// /statements/lease/:leaseId?start&end — one lease's statement; Print → Save as PDF from the browser.
export function StatementPage() {
  const { leaseId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const fallback = defaultRange()
  const start = params.get('start') ?? fallback.start
  const end = params.get('end') ?? fallback.end
  const range = validRange(start, end)

  const query = useQuery({
    queryKey: ['statement', leaseId, start, end],
    queryFn: () => api.get<{ data: LeaseStatement }>(`/statements/lease/${encodeURIComponent(leaseId)}?${statementQuery(range!)}`),
    enabled: range !== null && leaseId !== '',
  })
  const set = (k: 'start' | 'end', v: string) => setParams(p => { const n = new URLSearchParams(p); n.set(k, v); return n }, { replace: true })

  return (
    <div>
      <div data-print-hide>
        <PageHeader
          title="Tenant Statement"
          subtitle="One lease, as of the end date. Print and choose Save as PDF for a file copy."
          action={<Button type="button" onClick={() => window.print()} disabled={!query.data}>Print / PDF</Button>}
        />
        <div className="mb-6 flex flex-wrap items-end gap-4">
          <label className="text-sm">Start<DateInput value={start} onChange={e => set('start', e.target.value)} /></label>
          <label className="text-sm">End<DateInput value={end} onChange={e => set('end', e.target.value)} /></label>
          {range === null && <p role="alert" className="text-sm text-status-danger">Start must be on or before end.</p>}
        </div>
        {query.data && query.data.data.blockers.length > 0 && (
          <p role="status" className="mb-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-4 py-2 text-sm text-status-warning">
            Not ready to email: {query.data.data.blockers.map(b => BLOCKER_LABELS[b]).join('; ')}.
          </p>
        )}
      </div>
      {/* A disabled query reports isPending forever; only mount QueryState for a usable range. */}
      {range !== null && (
        <QueryState query={query}>
          {query.data && <StatementDocument data={query.data.data} />}
        </QueryState>
      )}
    </div>
  )
}
