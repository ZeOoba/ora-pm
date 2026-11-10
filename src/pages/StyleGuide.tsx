import { toast } from 'sonner'
import { Badge, StatusBadge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { KpiStat } from '../components/ui/KpiStat'
import { EmptyState } from '../components/ui/EmptyState'
import { Field } from '../components/form/Field'
import { TextInput, NumberInput, DateInput, Select, Textarea, Checkbox } from '../components/form/inputs'
import type { Tone } from '../components/ui/badge-tone'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '../components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { DataTable } from '../components/data-table/DataTable'
import { dataTableColumnHelper } from '../components/data-table/columns'
import { OccupancyDonut } from '../components/charts/OccupancyDonut'
import { AgingChart } from '../components/charts/AgingChart'
import { Gauge } from '../components/charts/Gauge'

// Fake data only - no real tenants, amounts or properties.
type SampleRow = { id: string; tenant: string; unit: string; rent: number; status: string }
const SAMPLE_ROWS: SampleRow[] = [
  { id: 's1', tenant: 'Acme Test LLC', unit: 'A-101', rent: 4500, status: 'active' },
  { id: 's2', tenant: 'Example Logistics Inc', unit: 'A-102', rent: 3200, status: 'expiring_soon' },
  { id: 's3', tenant: 'Sample Supply Co', unit: 'B-201', rent: 5100, status: 'overdue' },
  { id: 's4', tenant: 'Demo Fabrication LLC', unit: 'B-202', rent: 2800, status: 'vacant' },
]
const sample = dataTableColumnHelper<SampleRow>()
const SAMPLE_COLUMNS = [
  sample.accessor('tenant', { header: 'Tenant', enableSorting: true }),
  sample.accessor('unit', { header: 'Unit', enableSorting: true }),
  sample.accessor('rent', {
    header: 'Monthly rent',
    enableSorting: true,
    meta: { numeric: true },
    cell: ({ row }) => `$${row.original.rent.toLocaleString('en-US')}`,
  }),
  sample.accessor('status', { header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> }),
]
const SAMPLE_AGING = { current: 12000, d1_30: 4500, d31_60: 2100, d61_90: 900, d90_plus: 600, unallocated: 0, balance: 20100 }
const SAMPLE_SPLIT = { occupiedSf: 84000, vacantSf: 6000, unavailableSf: 2000, totalSf: 90000, occupiedPct: 93 }
const SWATCHES = [
  ['bg-navy', '#1B2A4A'],
  ['bg-navy-700', '#243660'],
  ['bg-gold', '#C9A96E'],
  ['bg-gold-600', '#B8975A'],
  ['bg-parchment', '#F5F3EF'],
  ['bg-ivory', '#FBF9F4'],
] as const

const TONES: Tone[] = ['active', 'warning', 'danger', 'pending', 'info', 'neutral']
const STATUSES = ['active', 'expiring_soon', 'overdue', 'pending', 'occupied', 'vacant', 'executed', 'missing']

export function StyleGuide() {
  return (
    <div className="min-h-screen bg-ivory p-10">
      <header className="mb-10">
        <p className="text-xs font-semibold uppercase tracking-wider text-gold">Oxford Realty Advisors</p>
        <h1 className="text-3xl font-display text-navy">P1 design system</h1>
        <p className="font-mono text-xs text-status-neutral mt-1">/styleguide</p>
      </header>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Color</h2>
        <div className="flex flex-wrap gap-3">
          {SWATCHES.map(([c, hex]) => (
            <div key={c} className="text-center">
              <div className={`${c} h-16 w-24 rounded-card border border-navy/10`} />
              <p className="font-mono text-[10px] text-status-neutral mt-1">{c}</p>
              <p className="font-mono text-[10px] text-status-neutral">{hex}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Typography</h2>
        <p className="font-display text-2xl text-navy">EB Garamond — display / headings</p>
        <p className="font-sans text-base text-navy">DM Sans — body &amp; UI</p>
        <p className="font-mono text-sm text-status-neutral">IBM Plex Mono — data &amp; provenance</p>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Badges</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {TONES.map(t => <Badge key={t} tone={t}>{t}</Badge>)}
        </div>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map(s => <StatusBadge key={s} status={s} />)}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Buttons</h2>
        <div className="flex flex-wrap gap-3">
          <Button variant="navy">Navy primary</Button>
          <Button variant="gold">Gold</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="navy" disabled>Disabled</Button>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">KPI stats</h2>
        <div className="grid grid-cols-4 gap-4">
          <KpiStat label="Occupancy" value="94%" sub="33 of 35 units" />
          <KpiStat label="Monthly Rent Roll" value="$248,500" sub="Active leases" />
          <KpiStat label="Outstanding AR" value="$12,300" sub="Unpaid charges" warn />
          <KpiStat label="Critical Dates" value={3} sub="Urgent or overdue" warn />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Dashboard money tiles &amp; gauges</h2>
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiStat accent="positive" label="Cash In" value="$21,742.54" sub="Payments received" />
          <KpiStat accent="negative" label="Cash Out" value="$4,241.46" sub="Expenses recorded" />
          <KpiStat accent="navy" label="Net Cash Flow" value="$17,501.08" sub="Cash in − cash out" />
          <KpiStat accent="warning" label="Outstanding AR" value="$12,300.00" sub="Unpaid charges, all dates" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Gauge title="Rent Collected" tone="positive" caption="84% of billed collected as of Nov 9, 2026" value={35511.7} max={42299.63}
            centerValue="$35,511.70" centerLabel="Collected" minLabel="$0.00" maxLabel="$42,299.63" />
          <Gauge title="% Occupied" caption="31 of 33 units rented as of Nov 9, 2026" value={31} max={33}
            centerValue="94%" centerLabel="Occupied" minLabel="0" maxLabel="100%" />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Cards</h2>
        <div className="grid grid-cols-3 gap-4">
          <Card variant="flat" className="p-4"><p className="font-display text-navy">Flat</p></Card>
          <Card variant="default" className="p-4"><p className="font-display text-navy">Default</p></Card>
          <Card variant="raised" className="p-4"><p className="font-display text-navy">Raised</p></Card>
        </div>
      </section>

      <section className="mb-10 max-w-lg">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Form controls</h2>
        <Card variant="default" className="p-6">
          <Field label="Text" required hint="Gold focus ring"><TextInput placeholder="e.g. Acme Logistics" /></Field>
          <Field label="Number"><NumberInput placeholder="4500" /></Field>
          <Field label="Date"><DateInput /></Field>
          <Field label="Select"><Select><option>NNN</option><option>Gross</option></Select></Field>
          <Field label="Notes"><Textarea placeholder="…" /></Field>
          <Checkbox label="Autopay enabled" />
        </Card>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Dialog, sheet and toasts</h2>
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild><Button variant="ghost">Open dialog</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Void charge?</DialogTitle>
                <DialogDescription>Sample dialog for Acme Test LLC. Use ConfirmDialog for confirm flows.</DialogDescription>
              </DialogHeader>
              <DialogFooter><Button variant="navy">Confirm</Button></DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild><Button variant="ghost">Open sheet</Button></SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Details</SheetTitle>
                <SheetDescription>Side panel for secondary detail and filters.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
          <Button variant="ghost" onClick={() => toast.success('Saved')}>Success toast</Button>
          <Button variant="ghost" onClick={() => toast.error('Could not save')}>Error toast</Button>
        </div>
      </section>

      <section className="mb-10 max-w-lg">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Tabs</h2>
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview"><p className="pt-3 text-sm text-muted-foreground">Overview panel.</p></TabsContent>
          <TabsContent value="activity"><p className="pt-3 text-sm text-muted-foreground">Activity panel.</p></TabsContent>
        </Tabs>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Data table (client mode, fake rows)</h2>
        <DataTable<SampleRow>
          mode="client"
          columns={SAMPLE_COLUMNS}
          queryKey={['styleguide', 'rows']}
          rows={SAMPLE_ROWS}
          clientSearchFn={(r, q) => r.tenant.toLowerCase().includes(q.toLowerCase())}
          searchPlaceholder="Search tenants…"
          csvFilename="styleguide-sample"
        />
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Charts (fake data)</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <OccupancyDonut split={SAMPLE_SPLIT} />
          <AgingChart totals={SAMPLE_AGING} className="" />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Empty state</h2>
        <Card variant="default">
          <EmptyState title="No leases on file" message="Upload your first lease to get started." action={<Button variant="gold">Upload lease</Button>} />
        </Card>
      </section>
    </div>
  )
}
