import type { RenewalStatus } from '../../types'

// Mirrors RenewalUpdateSchema.status (server/lib/schemas.ts); tests/components/renewal-status-edit.test.ts
// pins the two together so a new server status can't be silently missing from the picker.
export const RENEWAL_STATUS_OPTIONS: { value: RenewalStatus; label: string }[] = [
  { value: 'tracking', label: 'Tracking' },
  { value: 'proposal_sent', label: 'Proposal sent' },
  { value: 'negotiating', label: 'Negotiating' },
  { value: 'executed', label: 'Executed' },
  { value: 'declined', label: 'Declined' },
]

// PUT /api/renewals/:id body for an inline status change — status only (the schema is .strict()).
export function renewalStatusPayload(status: RenewalStatus): { status: RenewalStatus } {
  return { status }
}
