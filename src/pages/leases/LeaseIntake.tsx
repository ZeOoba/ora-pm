import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import { PageHeader } from '../../components/PageHeader'
import { Field } from '../../components/form/Field'
import { Select } from '../../components/form/inputs'
import { FileDropZone } from '../../components/ui/FileDropZone'
import { Card } from '../../components/ui/Card'
import { LeaseForm } from './LeaseForm'
import type { Tenant, Unit, Property } from '../../types'

type Stage = 'pick' | 'extracting' | 'review'

async function toBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function LeaseIntake() {
  const [stage, setStage] = useState<Stage>('pick')
  const [tenantId, setTenantId] = useState('')
  const [unitId, setUnitId] = useState('')
  const [error, setError] = useState('')
  const [initialValues, setInitialValues] = useState<Record<string, string>>({})
  const [confidence, setConfidence] = useState<Record<string, number>>({})
  const [warnings, setWarnings] = useState<string[]>([])

  const tenantsQ = useQuery({ queryKey: ['tenants'], queryFn: () => api.listAll<Tenant>('/tenants') })
  const unitsQ = useQuery({ queryKey: ['units', 'all'], queryFn: () => api.listAll<Unit>('/units') })
  const propsQ = useQuery({ queryKey: ['properties'], queryFn: () => api.listAll<Property>('/properties') })

  async function handleFile(file: File) {
    if (stage === 'extracting') return  // avoid a second egress call mid-extraction
    if (!tenantId || !unitId) { setError('Select a tenant and unit first.'); return }
    setError(''); setStage('extracting')
    try {
      const pdfBase64 = await toBase64(file)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/intake/lease', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ filename: file.name, pdfBase64, tenant_id: tenantId, unit_id: unitId }),
      })
      const json = await res.json() as { fields?: Record<string, unknown>; confidence?: Record<string, number>; warnings?: string[]; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Extraction failed')
      const stringified: Record<string, string> = { tenant_id: tenantId, unit_id: unitId }
      for (const [k, v] of Object.entries(json.fields ?? {})) if (v != null) stringified[k] = String(v)
      setInitialValues(stringified)
      setConfidence(json.confidence ?? {})
      setWarnings(json.warnings ?? [])
      setStage('review')
    } catch (e) {
      setError((e as Error).message); setStage('pick')
    }
  }

  const propName = new Map((propsQ.data ?? []).map(p => [p.id, p.name]))
  const tenants = tenantsQ.data ?? []
  const units = unitsQ.data ?? []

  if (stage === 'review') {
    return (
      <div>
        <PageHeader title="Review Extracted Lease" subtitle="Confirm the auto-filled fields before saving." />
        {warnings.length > 0 && (
          <Card variant="default" className="p-4 mb-4 border-status-warning/40 bg-status-warning/5">
            <ul className="text-sm text-status-warning list-disc list-inside">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </Card>
        )}
        <LeaseForm initialValues={initialValues} confidence={confidence} />
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title="Upload Lease" subtitle="Drop a lease PDF — we'll extract the key terms for your review." />
      <Card variant="default" className="p-6 mb-4">
        <p className="text-xs text-status-neutral mb-4">
          Managed-portfolio tenant leases only. The document text is sent to an external AI service for
          extraction — do NOT upload confidential acquisition or due-diligence documents.
        </p>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <Field label="Tenant" required>
            <Select value={tenantId} onChange={e => setTenantId(e.target.value)}>
              <option value="">Select tenant…</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Unit" required>
            <Select value={unitId} onChange={e => setUnitId(e.target.value)}>
              <option value="">Select unit…</option>
              {units.map(u => <option key={u.id} value={u.id}>{propName.get(u.property_id) ?? '—'} · {u.suite}</option>)}
            </Select>
          </Field>
        </div>
        <FileDropZone onFile={handleFile} />
        {error && <p className="mt-3 text-sm text-status-danger">{error}</p>}
      </Card>
      {stage === 'extracting' && <p className="text-sm text-status-neutral font-mono">Extracting lease terms…</p>}
    </div>
  )
}
