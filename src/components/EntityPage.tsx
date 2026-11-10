import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
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
  banner,
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
  /** Full-width content between the KPI strip and the tabs (e.g. a lease term timeline). */
  banner?: ReactNode
}) {
  const first = defaultTab ?? tabs[0]?.value
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-3xl leading-tight text-navy md:text-[40px]">{title}</h1>
            {status}
          </div>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {kpis && kpis.length > 0 && (
        <dl className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-4 border-b border-border pb-5">
          {kpis.map((k) => (
            <div key={k.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{k.label}</dt>
              <dd className={cn('truncate font-display text-[26px] leading-tight', k.warn ? 'text-status-danger' : 'text-navy')}>{k.value}</dd>
              {k.sub && <dd className="truncate text-xs text-muted-foreground">{k.sub}</dd>}
            </div>
          ))}
        </dl>
      )}

      {banner && <div className="mb-6">{banner}</div>}

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
