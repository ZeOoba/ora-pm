export type Tone = 'active' | 'warning' | 'danger' | 'pending' | 'info' | 'neutral'

const STATUS_TONE: Record<string, Tone> = {
  // active / good
  active: 'active', collected: 'active', executed: 'active', paid: 'active',
  // warning / attention
  expiring_soon: 'warning', notice: 'warning', warning: 'warning',
  urgent: 'warning', negotiating: 'warning',
  // danger / failure
  overdue: 'danger', terminated: 'danger', declined: 'danger', missing: 'danger',
  // pending / in-progress
  pending: 'pending',
  // info / neutral-active
  occupied: 'info', billed: 'info', proposal_sent: 'info', auto: 'info',
  // neutral / inactive
  expired: 'neutral', vacant: 'neutral', unavailable: 'neutral',
  draft: 'neutral', manual: 'neutral', tracking: 'neutral',
}

export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral'
}

export const TONE_CLASSES: Record<Tone, string> = {
  active:  'bg-status-active/10 text-status-active',
  warning: 'bg-status-warning/10 text-status-warning',
  danger:  'bg-status-danger/10 text-status-danger',
  pending: 'bg-status-pending/10 text-status-pending',
  info:    'bg-navy/10 text-navy',
  neutral: 'bg-status-neutral/10 text-status-neutral',
}
