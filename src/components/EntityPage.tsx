import type { ReactNode } from 'react'
import { KpiStat } from './ui/KpiStat'
import { Card } from './ui/Card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { ActivityTimeline } from './ActivityTimeline'
import type { TimelineItem } from './timeline'

export interface EntityKpi {
  label: string
  value: string | number
  sub?: string
  warn?: boolean
}

export interface EntityTab {
  value: string
  label: string
  content: ReactNode
}

/**
 * Shared shell for detail pages: header (title, subtitle, status badge, actions), KPI strip,
 * Radix tabs, and an optional activity timeline (newest first) beside the tab content.
 */
export function EntityPage({
  title,
  subtitle,
  status,
  actions,
  kpis,
  tabs,
  defaultTab,
  timeline,
  timelineTitle = 'Activity',
}: {
  title: string
  subtitle?: string
  status?: ReactNode
  actions?: ReactNode
  kpis?: EntityKpi[]
  tabs: EntityTab[]
  defaultTab?: string
  timeline?: TimelineItem[]
  timelineTitle?: string
}) {
  const first = defaultTab ?? tabs[0]?.value
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-display text-navy">{title}</h1>
            {status}
          </div>
          {subtitle && <p className="mt-0.5 text-sm text-status-neutral">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {kpis && kpis.length > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((k) => (
            <KpiStat key={k.label} label={k.label} value={k.value} sub={k.sub} warn={k.warn} />
          ))}
        </div>
      )}

      <div className={timeline ? 'grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]' : ''}>
        <Tabs defaultValue={first} className="min-w-0 gap-4">
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="flex-none px-3 py-1.5">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
        {timeline && (
          <aside aria-label={timelineTitle}>
            <Card className="p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-status-neutral">{timelineTitle}</h2>
              <ActivityTimeline items={timeline} />
            </Card>
          </aside>
        )}
      </div>
    </div>
  )
}

/** Label/value rows for overview cards. */
export function DetailList({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">{children}</dl>
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start text-sm">
      <dt className="w-32 shrink-0 text-status-neutral">{label}</dt>
      <dd className="font-medium text-navy">{children}</dd>
    </div>
  )
}

export function SectionCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-status-neutral">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  )
}
