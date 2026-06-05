import { statusTone, TONE_CLASSES, type Tone } from './badge-tone'

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  )
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status.replace(/_/g, ' ')}</Badge>
}
