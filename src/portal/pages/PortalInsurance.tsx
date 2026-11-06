import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { portalSupabase } from '../lib/supabase-portal'
import { portalApi } from '../lib/portal-api'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { QueryState } from '../../components/QueryState'

export function PortalInsurance() {
  const [form, setForm] = useState({
    policy_type: 'general_liability',
    carrier: '',
    policy_number: '',
    coverage_amount: '',
    effective_date: '',
    expiration_date: '',
  })
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const qc = useQueryClient()

  // OI-071: the storage RLS policy (tenant_upload_insurance, migration 0008)
  // keys the folder on public.tenants.id — NOT the Supabase auth user id
  // (session.user.id), which is a different uuid. Same query PortalPayNow and
  // PortalDashboard use.
  const meQuery = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const { data: meData } = meQuery

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const tenantId = meData?.tenant.id
    if (!tenantId) { setStatus('error'); setErrorMsg('Your account details are still loading — try again in a moment.'); return }

    setStatus('uploading')
    setErrorMsg('')

    const { data: { session } } = await portalSupabase.auth.getSession()
    if (!session) { setStatus('error'); setErrorMsg('Not authenticated'); return }

    let storagePath: string | null = null

    if (file) {
      const fileName = `${tenantId}/${file.name}`

      const { error: uploadErr } = await portalSupabase.storage
        .from('insurance-certs')
        .upload(fileName, file, { upsert: true })

      if (uploadErr) { setStatus('error'); setErrorMsg(uploadErr.message); return }
      storagePath = fileName
    }

    try {
      const res = await fetch('/api/portal/insurance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          ...form,
          coverage_amount: form.coverage_amount ? parseFloat(form.coverage_amount) : null,
          storage_path: storagePath,
        }),
      })
      if (!res.ok) {
        const err = await res.json() as { error: string }
        throw new Error(err.error)
      }
      setStatus('done')
      qc.invalidateQueries({ queryKey: ['portal-insurance'] })
    } catch (err) {
      setStatus('error')
      setErrorMsg((err as Error).message)
    }
  }

  if (status === 'done') return (
    <div className="p-6 max-w-lg">
      <div className="bg-status-active/5 border border-status-active/30 rounded-lg p-6">
        <h2 className="font-display text-lg font-semibold text-status-active">Certificate Submitted</h2>
        <p className="text-status-active mt-2 text-sm">
          Your insurance certificate has been received. Your property manager will review it shortly.
        </p>
        <button onClick={() => setStatus('idle')} className="mt-4 text-navy text-sm underline-offset-2 hover:underline">
          Upload another
        </button>
      </div>
    </div>
  )

  return (
    <div className="p-6 max-w-lg space-y-4">
      <h1 className="font-display text-2xl text-navy">Insurance</h1>
      <p className="text-sm text-status-neutral">Upload your current Certificate of Insurance (COI). Required per your lease.</p>

      {status === 'error' && (
        <div role="alert" className="bg-status-danger/5 border border-status-danger/30 rounded p-4 text-status-danger text-sm">{errorMsg}</div>
      )}

      {/* portal-me status: skeleton, error + retry, stale warning. The form stays mounted: its submit
          button is already disabled until the tenant profile has loaded. */}
      <QueryState query={meQuery} skeleton={<p className="text-xs text-status-neutral" aria-busy="true">Loading your account…</p>}>{null}</QueryState>

      <Card className="p-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-navy mb-1">Policy type</label>
          <select
            value={form.policy_type}
            onChange={e => setForm(f => ({ ...f, policy_type: e.target.value }))}
            className="w-full border border-navy/15 rounded px-3 py-2 text-sm"
          >
            <option value="general_liability">General Liability</option>
            <option value="property">Property</option>
            <option value="workers_comp">Workers Comp</option>
            <option value="umbrella">Umbrella</option>
            <option value="other">Other</option>
          </select>
        </div>

        {(['carrier', 'policy_number'] as const).map(field => (
          <div key={field}>
            <label className="block text-sm font-medium text-navy mb-1 capitalize">
              {field.replace('_', ' ')}
            </label>
            <input
              type="text"
              value={form[field]}
              onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
              className="w-full border border-navy/15 rounded px-3 py-2 text-sm"
            />
          </div>
        ))}

        <div>
          <label className="block text-sm font-medium text-navy mb-1">Coverage amount ($)</label>
          <input
            type="number"
            value={form.coverage_amount}
            onChange={e => setForm(f => ({ ...f, coverage_amount: e.target.value }))}
            className="w-full border border-navy/15 rounded px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-navy mb-1">Effective date</label>
            <input
              type="date"
              required
              value={form.effective_date}
              onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))}
              className="w-full border border-navy/15 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy mb-1">Expiration date</label>
            <input
              type="date"
              required
              value={form.expiration_date}
              onChange={e => setForm(f => ({ ...f, expiration_date: e.target.value }))}
              className="w-full border border-navy/15 rounded px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-navy mb-1">Upload COI (PDF)</label>
          <input
            type="file"
            accept=".pdf,.jpg,.png"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm text-status-neutral"
          />
        </div>

        <Button
          type="submit"
          disabled={status === 'uploading' || !meData?.tenant}
          className="w-full py-2.5"
        >
          {status === 'uploading' ? 'Uploading…' : meData?.tenant ? 'Submit Certificate' : meQuery.isError ? 'Unavailable' : 'Loading account…'}
        </Button>
      </form>
      </Card>
    </div>
  )
}
