import { Badge, StatusBadge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { KpiStat } from '../components/ui/KpiStat'
import { EmptyState } from '../components/ui/EmptyState'
import { Field } from '../components/form/Field'
import { TextInput, NumberInput, DateInput, Select, Textarea, Checkbox } from '../components/form/inputs'
import type { Tone } from '../components/ui/badge-tone'

const TONES: Tone[] = ['active', 'warning', 'danger', 'pending', 'info', 'neutral']
const STATUSES = ['active', 'expiring_soon', 'overdue', 'pending', 'occupied', 'vacant', 'executed', 'missing']

export function StyleGuide() {
  return (
    <div className="min-h-screen bg-ivory p-10">
      <header className="mb-10">
        <p className="text-xs font-semibold uppercase tracking-wider text-gold">Oxford Realty Advisors</p>
        <h1 className="text-3xl font-display text-navy">Design System</h1>
        <p className="font-mono text-xs text-status-neutral mt-1">/styleguide · Phase 1 visual reference</p>
      </header>

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Color</h2>
        <div className="flex flex-wrap gap-3">
          {['bg-navy', 'bg-navy-700', 'bg-gold', 'bg-gold-600', 'bg-parchment', 'bg-ivory'].map(c => (
            <div key={c} className="text-center">
              <div className={`${c} h-16 w-24 rounded-card border border-navy/10`} />
              <p className="font-mono text-[10px] text-status-neutral mt-1">{c}</p>
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
        <h2 className="text-sm font-semibold uppercase tracking-wider text-status-neutral mb-3">Empty state</h2>
        <Card variant="default">
          <EmptyState title="No leases on file" message="Upload your first lease to get started." action={<Button variant="gold">Upload lease</Button>} />
        </Card>
      </section>
    </div>
  )
}
