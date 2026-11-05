import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { portalApi } from '../lib/portal-api'
import { portalSupabase } from '../lib/supabase-portal'
import type { Lease } from '../lib/portal-api'
import type { Factor } from '@supabase/supabase-js'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/QueryState'

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
  const meQuery = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const leaseQuery = useQuery({ queryKey: ['portal-lease'], queryFn: portalApi.getLease })
  const { data: meData } = meQuery
  const { data: leaseData } = leaseQuery

  const tenant = meData?.tenant
  const leases = (leaseData?.data ?? []) as LeaseWithAutopay[]

  const [autopayStatus, setAutopayStatus] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [autopayError, setAutopayError] = useState<Record<string, string>>({})

  async function toggleAutopay(leaseId: string, currentEnabled: boolean) {
    setSaving(leaseId)
    setAutopayError(s => ({ ...s, [leaseId]: '' }))
    try {
      await portalApi.setAutopay(leaseId, !currentEnabled)
      setAutopayStatus(s => ({ ...s, [leaseId]: !currentEnabled }))
      qc.invalidateQueries({ queryKey: ['portal-lease'] })
    } catch (err) {
      // OI-081: requireAal2 now blocks this call (403) for a tenant with no
      // enrolled MFA factor, instead of the prior silent pass-through — that
      // rejection needs to reach the UI (mirrors PortalPayNow.tsx's catch),
      // not disappear as an unhandled promise rejection while the toggle
      // silently reverts.
      setAutopayError(s => ({ ...s, [leaseId]: (err as Error).message }))
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
      <h1 className="font-display text-2xl text-navy">Account</h1>

      <QueryState query={[meQuery, leaseQuery]}>
      <Card className="p-5 space-y-3">
        <h2 className="font-medium text-navy">Profile</h2>
        <div className="text-sm text-status-neutral space-y-1">
          <p><span className="text-status-neutral">Company:</span> {tenant?.name ?? '—'}</p>
          <p><span className="text-status-neutral">Email:</span> {tenant?.contact_email ?? '—'}</p>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-medium text-navy">Autopay</h2>
        <p className="text-sm text-status-neutral">
          When enabled, rent and CAM charges are automatically paid via ACH on the 1st of each month using your verified bank account.
        </p>
        {leases.length === 0 && (
          <p className="text-sm text-status-neutral">No active leases found.</p>
        )}
        {leases.map(lease => {
          const enabled = autopayStatus[lease.id] ?? lease.autopay_enabled
          return (
            <div key={lease.id} className="flex items-center justify-between py-2 border-t border-border">
              <div>
                <p className="text-sm font-medium text-navy">
                  {lease.units?.properties?.name ?? 'Property'} — Suite {lease.units?.suite}
                </p>
                <p className="text-xs text-status-neutral">
                  {lease.autopay_payment_method_id
                    ? 'Bank account on file'
                    : 'No bank account linked — pay once to save'}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={() => toggleAutopay(lease.id, enabled)}
                  disabled={saving === lease.id || !lease.autopay_payment_method_id}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
                    enabled
                      ? 'bg-status-active/10 text-status-active hover:bg-status-active/20'
                      : 'bg-muted text-status-neutral hover:bg-border'
                  } disabled:opacity-50`}
                >
                  {saving === lease.id ? '…' : enabled ? 'Autopay ON' : 'Autopay OFF'}
                </button>
                {autopayError[lease.id] && (
                  <p role="alert" className="text-xs text-status-danger max-w-[220px] text-right">{autopayError[lease.id]}</p>
                )}
              </div>
            </div>
          )
        })}
      </Card>
      </QueryState>

      <Card className="p-5 space-y-3">
        <h2 className="font-medium text-navy">Security</h2>
        <p className="text-sm text-status-neutral">Enable two-factor authentication (TOTP) for additional account security.</p>
        <button onClick={openMfaModal} className="text-sm text-navy underline-offset-2 hover:underline">
          Manage two-factor authentication →
        </button>
      </Card>

      {mfaModalOpen && (
        <div className="fixed inset-0 bg-navy/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-navy">Two-factor authentication</h3>
              <button onClick={closeMfaModal} aria-label="Close" className="text-status-neutral hover:text-navy">
                ×
              </button>
            </div>

            {mfaError && <p role="alert" className="text-sm text-status-danger">{mfaError}</p>}

            {factorsLoading && <p className="text-sm text-status-neutral">Loading…</p>}

            {!factorsLoading && factors.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-status-neutral uppercase tracking-wide">Active factors</p>
                {factors.map(f => (
                  <div key={f.id} className="flex items-center justify-between text-sm">
                    <span className="text-navy">{f.friendly_name ?? 'Authenticator app'}</span>
                    <button
                      onClick={() => removeFactor(f.id)}
                      disabled={mfaBusy}
                      className="text-xs text-status-danger hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!factorsLoading && factors.length === 0 && !enrollment && !mfaSuccess && (
              <button onClick={startEnrollment} disabled={mfaBusy} className="text-sm text-navy underline-offset-2 hover:underline">
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
                <p className="text-xs text-status-neutral break-all">
                  Can't scan? Enter this code manually: <span className="font-mono">{enrollment.secret}</span>
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  required
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="6-digit code"
                  className="w-full border border-navy/15 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                />
                <Button type="submit" disabled={mfaBusy} className="w-full">
                  Verify
                </Button>
              </form>
            )}

            {mfaSuccess && <p className="text-sm text-status-active">Two-factor authentication enabled.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
