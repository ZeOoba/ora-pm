import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { runExclusive } from '../../lib/run-exclusive'
import { ConfirmDialog } from '../../components/ConfirmDialog'

interface Tenant {
  id: string
  name: string
  contact_email: string | null
  auth_user_id: string | null
}

export function TenantPortalAdmin({ tenant }: { tenant: Tenant }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [revoking, setRevoking] = useState(false)
  // Synchronous in-flight guard (state updates are async, so a fast double click could slip past `revoking`).
  const revokeInFlight = useRef(false)
  const qc = useQueryClient()

  async function invite() {
    setStatus('sending')
    setErrorMsg('')
    try {
      await api.post(`/admin/tenants/${tenant.id}/invite`, {})
      setStatus('done')
      qc.invalidateQueries({ queryKey: ['tenant', tenant.id] })
    } catch (e) {
      setStatus('error')
      setErrorMsg((e as Error).message)
    }
  }

  async function revoke() {
    await runExclusive(revokeInFlight, async () => {
      setRevoking(true)
      try {
        await api.del(`/admin/tenants/${tenant.id}/revoke-access`)
        await qc.invalidateQueries({ queryKey: ['tenant', tenant.id] })
        toast.success(`Portal access revoked for ${tenant.name}`)
      } catch (e) {
        // Surface the failure so a revoke can't silently no-op.
        toast.error(`Failed to revoke access: ${(e as Error).message}`)
      } finally {
        setRevoking(false)
        setConfirmRevoke(false)
      }
    })
  }

  const hasAccess = !!tenant.auth_user_id

  return (
    <div className="bg-white rounded-lg border border-border p-5 space-y-3">
      <h3 className="font-medium text-sm uppercase tracking-wide text-muted-foreground">Tenant Portal</h3>
      {hasAccess ? (
        <div className="flex items-center justify-between">
          <div>
            <span className="inline-block bg-status-active/10 text-status-active text-xs px-2 py-0.5 rounded-full">
              Access granted
            </span>
            <p className="text-xs text-muted-foreground mt-1 font-mono">{tenant.auth_user_id}</p>
          </div>
          <button onClick={() => setConfirmRevoke(true)} className="text-xs text-status-danger hover:underline">
            Revoke access
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {!tenant.contact_email && (
            <p className="text-xs text-amber-600">No contact email — add one to the tenant record first.</p>
          )}
          {status === 'done' && (
            <p className="text-xs text-status-active">Invite sent to {tenant.contact_email}</p>
          )}
          {status === 'error' && (
            <p className="text-xs text-status-danger">{errorMsg}</p>
          )}
          <button
            onClick={invite}
            disabled={status === 'sending' || !tenant.contact_email}
            className="text-sm bg-[#1B2A4A] text-white px-4 py-1.5 rounded hover:bg-[#243660] disabled:opacity-50"
          >
            {status === 'sending' ? 'Sending…' : 'Send portal invite'}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="Revoke portal access?"
        description={`${tenant.name} will be signed out of the tenant portal immediately.`}
        confirmLabel="Revoke access"
        pendingLabel="Revoking…"
        destructive
        pending={revoking}
        onConfirm={() => void revoke()}
      />
    </div>
  )
}
