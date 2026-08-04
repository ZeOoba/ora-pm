import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { portalSupabase } from '../lib/supabase-portal'
import type { Lease } from '../lib/portal-api'
import type { Factor } from '@supabase/supabase-js'

interface LeaseWithAutopay extends Lease {
  units: NonNullable<Lease['units']>
}

interface TotpEnrollment {
  factorId: string
  qrCode: string
  secret: string
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

  const [mfaModalOpen, setMfaModalOpen] = useState(false)
  const [factors, setFactors] = useState<Factor[]>([])
  const [factorsLoading, setFactorsLoading] = useState(false)
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null)
  const [code, setCode] = useState('')
  const [mfaError, setMfaError] = useState('')
  const [mfaBusy, setMfaBusy] = useState(false)
  const [mfaSuccess, setMfaSuccess] = useState(false)

  // Loads the tenant's MFA factors and, as a side effect of normal use, clears out
  // any factor still stuck in 'unverified' status -- the orphan accumulation left by
  // the old fire-and-forget enroll() call, where a repeated click (or an abandoned
  // enrollment) never got cleaned up because nothing ever challenged/verified it.
  async function loadFactors() {
    setFactorsLoading(true)
    setMfaError('')
    try {
      const { data, error } = await portalSupabase.auth.mfa.listFactors()
      if (error) throw error
      const all = data?.all ?? []
      await Promise.all(
        all
          .filter(f => f.status === 'unverified')
          .map(f => portalSupabase.auth.mfa.unenroll({ factorId: f.id }))
      )
      setFactors(all.filter(f => f.status === 'verified'))
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Failed to load two-factor status')
    } finally {
      setFactorsLoading(false)
    }
  }

  function openMfaModal() {
    setMfaModalOpen(true)
    setEnrollment(null)
    setCode('')
    setMfaError('')
    setMfaSuccess(false)
    loadFactors()
  }

  function closeMfaModal() {
    setMfaModalOpen(false)
  }

  async function startEnrollment() {
    setMfaBusy(true)
    setMfaError('')
    try {
      const { data, error } = await portalSupabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'Oxford Realty Advisors',
      })
      if (error) throw error
      setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret })
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Failed to start enrollment')
    } finally {
      setMfaBusy(false)
    }
  }

  async function submitVerification(e: React.FormEvent) {
    e.preventDefault()
    if (!enrollment) return
    setMfaBusy(true)
    setMfaError('')
    try {
      const { data: challengeData, error: challengeError } = await portalSupabase.auth.mfa.challenge({
        factorId: enrollment.factorId,
      })
      if (challengeError) throw challengeError
      const { error: verifyError } = await portalSupabase.auth.mfa.verify({
        factorId: enrollment.factorId,
        challengeId: challengeData.id,
        code,
      })
      if (verifyError) throw verifyError
      setEnrollment(null)
      setCode('')
      setMfaSuccess(true)
      await loadFactors()
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Invalid code')
    } finally {
      setMfaBusy(false)
    }
  }

  async function removeFactor(factorId: string) {
    setMfaBusy(true)
    setMfaError('')
    try {
      const { error } = await portalSupabase.auth.mfa.unenroll({ factorId })
      if (error) throw error
      await loadFactors()
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Failed to remove factor')
    } finally {
      setMfaBusy(false)
    }
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
        <button onClick={openMfaModal} className="text-sm text-blue-600 hover:underline">
          Manage two-factor authentication →
        </button>
      </div>

      {mfaModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-gray-900">Two-factor authentication</h3>
              <button onClick={closeMfaModal} aria-label="Close" className="text-gray-400 hover:text-gray-600">
                ×
              </button>
            </div>

            {mfaError && <p className="text-sm text-red-600">{mfaError}</p>}

            {factorsLoading && <p className="text-sm text-gray-500">Loading…</p>}

            {!factorsLoading && factors.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Active factors</p>
                {factors.map(f => (
                  <div key={f.id} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700">{f.friendly_name ?? 'Authenticator app'}</span>
                    <button
                      onClick={() => removeFactor(f.id)}
                      disabled={mfaBusy}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!factorsLoading && factors.length === 0 && !enrollment && !mfaSuccess && (
              <button onClick={startEnrollment} disabled={mfaBusy} className="text-sm text-blue-600 hover:underline">
                Set up →
              </button>
            )}

            {enrollment && (
              <form onSubmit={submitVerification} className="space-y-3">
                <img
                  src={`data:image/svg+xml;utf-8,${enrollment.qrCode}`}
                  alt="Scan with your authenticator app"
                  width={180}
                  height={180}
                  className="mx-auto"
                />
                <p className="text-xs text-gray-500 break-all">
                  Can't scan? Enter this code manually: <span className="font-mono">{enrollment.secret}</span>
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  required
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="6-digit code"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  disabled={mfaBusy}
                  className="w-full bg-[#1B2A4A] text-white rounded px-4 py-2 text-sm font-medium hover:bg-[#243660] disabled:opacity-50"
                >
                  Verify
                </button>
              </form>
            )}

            {mfaSuccess && <p className="text-sm text-green-700">Two-factor authentication enabled.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
