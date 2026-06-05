import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { portalSupabase } from '../lib/supabase-portal'

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('uploading')
    setErrorMsg('')

    const { data: { session } } = await portalSupabase.auth.getSession()
    if (!session) { setStatus('error'); setErrorMsg('Not authenticated'); return }

    let storagePath: string | null = null

    if (file) {
      const tenantId = session.user.id
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
      <div className="bg-green-50 border border-green-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-green-800">Certificate Submitted</h2>
        <p className="text-green-700 mt-2 text-sm">
          Your insurance certificate has been received. Your property manager will review it shortly.
        </p>
        <button onClick={() => setStatus('idle')} className="mt-4 text-blue-600 text-sm hover:underline">
          Upload another
        </button>
      </div>
    </div>
  )

  return (
    <div className="p-6 max-w-lg space-y-4">
      <h1 className="text-2xl font-serif" style={{ color: '#1B2A4A' }}>Insurance</h1>
      <p className="text-sm text-gray-500">Upload your current Certificate of Insurance (COI). Required per your lease.</p>

      {status === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded p-4 text-red-700 text-sm">{errorMsg}</div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Policy type</label>
          <select
            value={form.policy_type}
            onChange={e => setForm(f => ({ ...f, policy_type: e.target.value }))}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
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
            <label className="block text-sm font-medium text-gray-700 mb-1 capitalize">
              {field.replace('_', ' ')}
            </label>
            <input
              type="text"
              value={form[field]}
              onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>
        ))}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Coverage amount ($)</label>
          <input
            type="number"
            value={form.coverage_amount}
            onChange={e => setForm(f => ({ ...f, coverage_amount: e.target.value }))}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Effective date</label>
            <input
              type="date"
              required
              value={form.effective_date}
              onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expiration date</label>
            <input
              type="date"
              required
              value={form.expiration_date}
              onChange={e => setForm(f => ({ ...f, expiration_date: e.target.value }))}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Upload COI (PDF)</label>
          <input
            type="file"
            accept=".pdf,.jpg,.png"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm text-gray-600"
          />
        </div>

        <button
          type="submit"
          disabled={status === 'uploading'}
          className="w-full bg-[#1B2A4A] text-white rounded px-4 py-2.5 text-sm font-medium hover:bg-[#243660] disabled:opacity-50"
        >
          {status === 'uploading' ? 'Uploading…' : 'Submit Certificate'}
        </button>
      </form>
    </div>
  )
}
