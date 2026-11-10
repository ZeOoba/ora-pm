import { cn } from '@/lib/utils'

/** Pill toggle between alternate views of one page (pair with useView from ./view-param). */
export function ViewToggle<T extends string>({ options, value, onChange, labels }: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  labels?: Partial<Record<T, string>>
}) {
  return (
    <div role="radiogroup" aria-label="View" className="flex gap-1.5 text-[13px]">
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={o === value} onClick={() => onChange(o)}
          className={cn('rounded-full border px-3 py-1.5 capitalize',
            o === value ? 'border-navy bg-navy text-white' : 'border-border bg-card text-navy hover:bg-muted')}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  )
}
