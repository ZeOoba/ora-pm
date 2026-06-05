import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { portalSupabase } from '../lib/supabase-portal'
import type { Lease } from '../lib/portal-api'

interface LeaseWithAutopay extends Lease {
  units: NonNullable<Lease['units']>
}

export function PortalAccount() {
  const qc = useQueryClient()
  const { data: meData } = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const { data: leaseData } = useQuery({ queryKey: ['portal-lease'], queryFn: portalApi.getLease })

  const tenant = meData?.tenant
  const leases = (leaseData?.data ?? []) as LeaseWithAutopay[]

  const [autopayStatus, setAutopayStatus] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<string | null>(null)

  async function toggleAutopay(leaseId: string, currentEnabled: boolean) {
    setSaving(leaseId)
    try {
      await portalApi.setAutopay(leaseId, !currentEnabled)
      setAutopayStatus(s => ({ ...s, [leaseId]: !currentEnabled }))
      qc.invalidateQueries({ queryKey: ['portal-lease'] })
    } finally {
      setSaving(null)
    }
  }

  async function handleMFA() {
    await portalSupabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'Oxford Realty Advisors' })
  }

  return (
    <div className="p-6 max-w-lg space-y-6">
      <h1 className="text-2xl font-serif" style={{ color: '#1B2A4A' }}>Account</h1>

      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
        <h2 className="font-medium text-gray-900">Profile</h2>
        <div className="text-sm text-gray-600 space-y-1">
          <p><span className="text-gray-500">Company:</span> {tenant?.name ?? '—'}</p>
          <p><span className="text-gray-500">Email:</span> {tenant?.contact_email ?? '—'}</p>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
        <h2 className="font-medium text-gray-900">Autopay</h2>
        <p className="text-sm text-gray-500">
          When enabled, rent and CAM charges are automatically paid via ACH on the 1st of each month using your verified bank account.
        </p>
        {leases.length === 0 && (
          <p className="text-sm text-gray-400">No active leases found.</p>
        )}
        {leases.map(lease => {
          const enabled = autopayStatus[lease.id] ?? lease.autopay_enabled
          return (
            <div key={lease.id} className="flex items-center justify-between py-2 border-t border-gray-50">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {lease.units?.properties?.name ?? 'Property'} — Suite {lease.units?.suite}
                </p>
                <p className="text-xs text-gray-500">
                  {lease.autopay_payment_method_id
                    ? 'Bank account on file'
                    : 'No bank account linked — pay once to save'}
                </p>
              </div>
              <button
                onClick={() => toggleAutopay(lease.id, enabled)}
                disabled={saving === lease.id || !lease.autopay_payment_method_id}
                className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
                  enabled
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } disabled:opacity-50`}
              >
                {saving === lease.id ? '…' : enabled ? 'Autopay ON' : 'Autopay OFF'}
              </button>
            </div>
          )
        })}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
        <h2 className="font-medium text-gray-900">Security</h2>
        <p className="text-sm text-gray-500">Enable two-factor authentication (TOTP) for additional account security.</p>
        <button onClick={handleMFA} className="text-sm text-blue-600 hover:underline">
          Set up two-factor authentication →
        </button>
      </div>
    </div>
  )
}
