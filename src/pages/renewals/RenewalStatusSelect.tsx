import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { Select } from '../../components/form/inputs'
import type { RenewalStatus } from '../../types'
import { RENEWAL_STATUS_OPTIONS, renewalStatusPayload } from './renewal-status'

// Inline status/decision edit for a Renewals row. A native <select>: DataTable's ClickableRow
// already ignores clicks inside `select`, so changing status never navigates to the lease.
export function RenewalStatusSelect({ id, status, tenantName }: { id: string; status: RenewalStatus; tenantName?: string }) {
  const qc = useQueryClient()
  const mutation = useMutation<unknown, Error, RenewalStatus>({
    mutationFn: (next) => api.put(`/renewals/${id}`, renewalStatusPayload(next)),
    onSuccess: (_res, next) => {
      const label = RENEWAL_STATUS_OPTIONS.find((o) => o.value === next)?.label ?? next
      toast.success(`Renewal${tenantName ? ` for ${tenantName}` : ''} set to ${label}`)
      return qc.invalidateQueries({ queryKey: ['renewals'] })
    },
    onError: (e) => toast.error(`Failed to update renewal: ${e.message}`),
  })

  // While saving, show the requested value; on error the select falls back to the server value.
  const value = mutation.isPending && mutation.variables ? mutation.variables : status
  return (
    <Select
      aria-label={`Renewal status${tenantName ? ` for ${tenantName}` : ''}`}
      className="w-40 py-1"
      value={value}
      disabled={mutation.isPending}
      onChange={(e) => mutation.mutate(e.target.value as RenewalStatus)}
    >
      {RENEWAL_STATUS_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </Select>
  )
}
