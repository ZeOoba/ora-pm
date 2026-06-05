import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

interface Tenant {
  id: string
  name: string
  contact_email: string | null
  auth_user_id: string | null
}

export function TenantPortalAdmin({ tenant }: { tenant: Tenant }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const qc = useQueryClient()

  async function invite() {
    setStatus('sending')
    setErrorMsg('')
    const res = await fetch(`/api/admin/tenants/${tenant.id}/invite`, { method: 'POST' })
    if (res.ok) {
      setStatus('done')
      qc.invalidateQueries({ queryKey: ['tenant', tenant.id] })
    } else {
      const e = await res.json() as { error: string }
      setStatus('error')
      setErrorMsg(e.error)
    }
  }

  async function revoke() {
    if (!confirm(`Revoke portal access for ${tenant.name}? They will be signed out immediately.`)) return
    const res = await fetch(`/api/admin/tenants/${tenant.id}/revoke-access`, { method: 'DELETE' })
    if (res.ok) qc.invalidateQueries({ queryKey: ['tenant', tenant.id] })
  }

  const hasAccess = !!tenant.auth_user_id

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
      <h3 className="font-medium text-gray-900 text-sm uppercase tracking-wide text-gray-400">Tenant Portal</h3>
      {hasAccess ? (
        <div className="flex items-center justify-between">
          <div>
            <span className="inline-block bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">
              Access granted
            </span>
            <p className="text-xs text-gray-400 mt-1 font-mono">{tenant.auth_user_id}</p>
          </div>
          <button onClick={revoke} className="text-xs text-red-600 hover:underline">
            Revoke access
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {!tenant.contact_email && (
            <p className="text-xs text-amber-600">No contact email — add one to the tenant record first.</p>
          )}
          {status === 'done' && (
            <p className="text-xs text-green-700">Invite sent to {tenant.contact_email}</p>
          )}
          {status === 'error' && (
            <p className="text-xs text-red-600">{errorMsg}</p>
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
    </div>
  )
}
