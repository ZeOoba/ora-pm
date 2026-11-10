import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { QueryState } from '../../components/QueryState'
import { ViewToggle } from '../../components/ViewToggle'
import { useView } from '../../components/view-param'
import { DataTable } from '../../components/data-table/DataTable'
import { dataTableColumnHelper } from '../../components/data-table/columns'
import { csvFilename } from '../../components/data-table/csv'
import { formatDate } from '../../lib/format'
import type { Renewal, RentRollRow } from '../../types'
import { RenewalStatusSelect } from './RenewalStatusSelect'
import { compactMoney, daysBetween } from '../today/today-queue'
import { renewalBoard, renewalLanes, timelineMonths, type RenewalRecord } from '../money/money-derive'
import { RenewalsBoard, RenewalsTimeline } from '../money/RenewalsViews'

type RenewalRow = Renewal & {
  leases: {
    tenants: { name: string }
    units: { suite: string; properties: { name: string } }
  }
}

const h = dataTableColumnHelper<RenewalRow>()

const propertySuite = (r: RenewalRow) =>
  `${r.leases?.units?.properties?.name ?? '—'} · ${r.leases?.units?.suite ?? '—'}`

// Sortable ids match the server allowlist: expiration_date, target_decision_date, status.
const columns = [
  h.accessor((r) => r.leases?.tenants?.name, {
    id: 'tenant',
    header: 'Tenant',
    cell: ({ row }) => <span className="font-medium text-foreground">{row.original.leases?.tenants?.name ?? '—'}</span>,
  }),
  h.accessor(propertySuite, {
    id: 'property_suite',
    header: 'Property / Suite',
    cell: ({ row }) => <span className="text-muted-foreground">{propertySuite(row.original)}</span>,
  }),
  h.accessor('expiration_date', {
    header: 'Expiration',
    enableSorting: true,
    cell: ({ row }) => formatDate(row.original.expiration_date),
  }),
  h.accessor('target_decision_date', {
    header: 'Decision By',
    enableSorting: true,
    cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.target_decision_date)}</span>,
  }),
  h.accessor('status', {
    header: 'Status',
    enableSorting: true,
    // Inline edit via PUT /api/renewals/:id (status only); CSV export still reads the raw status value.
    cell: ({ row }) => <RenewalStatusSelect id={row.original.id} status={row.original.status} tenantName={row.original.leases?.tenants?.name} />,
  }),
]

const VIEWS = ['timeline', 'board', 'list'] as const

export function RenewalsPipeline() {
  const [view, setView] = useView(VIEWS)
  return (
    <div>
      <PageHeader title="Renewals" action={<ViewToggle options={VIEWS} value={view} onChange={setView} />} />
      {view === 'list' ? (
        <DataTable<RenewalRow>
          columns={columns}
          queryKey={['renewals', 'list']}
          // /renewals is unpaged unless limit/offset are passed; DataTable always passes them.
          fetchPage={(p) => api.list<RenewalRow>('/renewals', p)}
          searchable={false}
          rowHref={(r) => `/leases/${r.lease_id}`}
          csvFilename={csvFilename('renewals')}
          initialSort={{ id: 'expiration_date', desc: false }}
          emptyTitle="No renewals tracked"
        />
      ) : (
        <RenewalsVisual view={view} />
      )}
    </div>
  )
}

function RenewalsVisual({ view }: { view: 'timeline' | 'board' }) {
  const today = new Date().toISOString().slice(0, 10)
  const rentRoll = useQuery({
    queryKey: ['rent-roll', ''],
    queryFn: () => api.get<{ data: RentRollRow[] }>('/reports/rent-roll').then((r) => r.data),
  })
  // Unpaged read (no limit/offset) — same contract the list view relies on.
  const renewals = useQuery({
    queryKey: ['renewals', 'all'],
    queryFn: () => api.get<{ data: RenewalRecord[] }>('/renewals').then((r) => r.data),
  })
  const rr = rentRoll.data ?? []
  const recs = renewals.data ?? []
  const lanes = renewalLanes(rr, recs, today)
  const next12 = lanes.filter((l) => daysBetween(today, l.end_date) <= 365)
  const abr12 = next12.reduce((s, l) => s + (l.abr ?? 0), 0)
  const sf12 = rr.filter((r) => next12.some((l) => l.lease_id === r.lease_id)).reduce((s, r) => s + (r.sf ?? 0), 0)
  const negotiating = next12.filter((l) => l.renewal?.status === 'negotiating' || l.renewal?.status === 'proposal_sent').length
  const untracked = next12.filter((l) => !l.renewal).length

  return (
    <QueryState query={[rentRoll, renewals]}>
      <div className="mb-5 flex flex-col gap-1">
        <h2 className="font-display text-3xl leading-tight text-navy md:text-[40px]">{compactMoney(abr12)} of base rent rolls in the next 12 months</h2>
        <p className="text-sm text-muted-foreground">
          {next12.length} {next12.length === 1 ? 'lease' : 'leases'} · {sf12.toLocaleString('en-US')} SF · {negotiating} with a proposal out or in negotiation · {untracked} not tracked
        </p>
      </div>
      {view === 'timeline'
        ? <RenewalsTimeline lanes={lanes} months={timelineMonths(today)} />
        : <RenewalsBoard columns={renewalBoard(lanes, recs, rr)} />}
    </QueryState>
  )
}
