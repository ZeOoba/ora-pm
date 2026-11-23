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
import { AbstractReview, type AbstractResponse, type OccupantLease } from './AbstractReview'
import type { Tenant, Unit, Property, Lease } from '../../types'

type Stage = 'pick' | 'extracting' | 'review' | 'abstract'
type Mode = 'abstract' | 'quick'

async function toBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

type LeaseRow = Lease & { tenants?: { name: string } | null }

export function LeaseIntake() {
  const [stage, setStage] = useState<Stage>('pick')
  const [mode, setMode] = useState<Mode>('abstract')
  const [tenantId, setTenantId] = useState('')
  const [unitId, setUnitId] = useState('')
  const [error, setError] = useState('')
  const [initialValues, setInitialValues] = useState<Record<string, string>>({})
  const [confidence, setConfidence] = useState<Record<string, number>>({})
  const [warnings, setWarnings] = useState<string[]>([])
  const [abstract, setAbstract] = useState<{ result: AbstractResponse; filename: string; pdfBase64: string } | null>(null)

  const tenantsQ = useQuery({ queryKey: ['tenants'], queryFn: () => api.listAll<Tenant>('/tenants') })
  const unitsQ = useQuery({ queryKey: ['units', 'all'], queryFn: () => api.listAll<Unit>('/units') })
  const propsQ = useQuery({ queryKey: ['properties'], queryFn: () => api.listAll<Property>('/properties') })
  const leasesQ = useQuery({ queryKey: ['leases', 'all-statuses'], queryFn: () => api.listAll<LeaseRow>('/leases') })

  const propName = new Map((propsQ.data ?? []).map(p => [p.id, p.name]))
  const tenants = tenantsQ.data ?? []
  const units = unitsQ.data ?? []
  const unit = units.find(u => u.id === unitId)
  const unitLabel = unit ? `${propName.get(unit.property_id) ?? '—'} · Suite ${unit.suite}` : ''
  const occupants: OccupantLease[] = (leasesQ.data ?? [])
    .filter(l => l.unit_id === unitId && (l.status === 'active' || l.status === 'pending'))
    .map(l => ({ id: l.id, start_date: l.start_date, end_date: l.end_date, status: l.status, tenant_name: l.tenants?.name ?? '—' }))

  async function handleFile(file: File) {
    if (stage === 'extracting') return  // avoid a second egress call mid-extraction
    if (!unitId) { setError('Select a unit first.'); return }
    if (mode === 'quick' && !tenantId) { setError('Quick extract needs a tenant; use the full abstract for a new tenant.'); return }
    setError(''); setStage('extracting')
    try {
      const pdfBase64 = await toBase64(file)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/intake/lease', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({
          filename: file.name, pdfBase64, unit_id: unitId,
          ...(tenantId ? { tenant_id: tenantId } : {}),
          ...(mode === 'abstract' ? { mode: 'abstract' } : {}),
        }),
      })
      const json = await res.json() as Record<string, unknown> & { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Extraction failed')
      if (mode === 'abstract') {
        setAbstract({ result: json as unknown as AbstractResponse, filename: file.name, pdfBase64 })
        setStage('abstract')
        return
      }
      const stringified: Record<string, string> = { tenant_id: tenantId, unit_id: unitId }
      for (const [k, v] of Object.entries((json.fields ?? {}) as Record<string, unknown>)) if (v != null) stringified[k] = String(v)
      setInitialValues(stringified)
      setConfidence((json.confidence ?? {}) as Record<string, number>)
      setWarnings((json.warnings ?? []) as string[])
      setStage('review')
    } catch (e) {
      setError((e as Error).message); setStage('pick')
    }
  }

  if (stage === 'abstract' && abstract) {
    return (
      <AbstractReview
        result={abstract.result} filename={abstract.filename} pdfBase64={abstract.pdfBase64}
        unitId={unitId} unitLabel={unitLabel} presetTenantId={tenantId} tenants={tenants} occupants={occupants}
        onCancel={() => { setAbstract(null); setStage('pick') }}
      />
    )
  }

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
      <PageHeader title="Upload Lease" subtitle="Drop a lease PDF — we'll abstract every term, tenant detail and note for your review." />
      <Card variant="default" className="p-6 mb-4">
        <p className="text-xs text-status-neutral mb-4">
          Managed-portfolio tenant leases only. The document text is sent to an external AI service for
          extraction — do NOT upload confidential acquisition or due-diligence documents.
        </p>
        <div className="flex gap-6 mb-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'abstract'} onChange={() => setMode('abstract')} /> Full abstract &amp; import (new or replacement tenant)</label>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === 'quick'} onChange={() => setMode('quick')} /> Quick extract (key terms only)</label>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <Field label="Unit" required>
            <Select value={unitId} onChange={e => setUnitId(e.target.value)}>
              <option value="">Select unit…</option>
              {units.map(u => <option key={u.id} value={u.id}>{propName.get(u.property_id) ?? '—'} · {u.suite}</option>)}
            </Select>
          </Field>
          <Field label={mode === 'abstract' ? 'Existing tenant (optional)' : 'Tenant'} required={mode === 'quick'}>
            <Select value={tenantId} onChange={e => setTenantId(e.target.value)}>
              <option value="">{mode === 'abstract' ? 'New tenant — create from lease' : 'Select tenant…'}</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        </div>
        {unitId && occupants.length > 0 && (
          <p className="text-xs text-status-neutral mb-4">
            Current: {occupants.map(o => `${o.tenant_name} (${o.status}, to ${o.end_date})`).join('; ')}. You can replace them on the review screen.
          </p>
        )}
        <FileDropZone onFile={handleFile} />
        {error && <p className="mt-3 text-sm text-status-danger">{error}</p>}
      </Card>
      {stage === 'extracting' && <p className="text-sm text-status-neutral font-mono">{mode === 'abstract' ? 'Abstracting the full lease (can take a minute)…' : 'Extracting lease terms…'}</p>}
    </div>
  )
}
