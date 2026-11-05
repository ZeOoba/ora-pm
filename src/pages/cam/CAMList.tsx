import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { runExclusive } from '../../lib/run-exclusive'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { Field } from '../../components/form/Field'
import { NumberInput, Select } from '../../components/form/inputs'
import { formatCurrency } from '../../lib/format'
import type { CAMReconciliation, Property, RentRollRow } from '../../types'

type CAMRow = CAMReconciliation & {
  leases: {
    tenants: { name: string } | null
    units: { suite: string; properties: { name: string } | null } | null
  } | null
}

const currentYear = new Date().getFullYear()

export function CAMList() {
  const qc = useQueryClient()

  const [propertyId, setPropertyId] = useState<string>('')
  const [year, setYear] = useState<number>(currentYear - 1)
  const [calculating, setCalculating] = useState(false)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [confirmRow, setConfirmRow] = useState<CAMRow | null>(null)
  // Row shown in the dialog text. Set alongside confirmRow but NOT cleared on close, so the text
  // doesn't blank during the exit animation.
  const [dialogRow, setDialogRow] = useState<CAMRow | null>(null)
  // Synchronous in-flight guard (state updates are async, so a fast double click could slip past `approvingId`).
  const approveInFlight = useRef(false)

  // ── Properties list ────────────────────────────────────────────────────────
  const { data: properties } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.listAll<Property>('/properties'),
  })

  // ── Rent roll for selected property (active leases) ────────────────────────
  const { data: rentRoll } = useQuery({
    queryKey: ['rent-roll', propertyId],
    queryFn: () =>
      api.get<{ data: RentRollRow[] }>(`/reports/rent-roll?property_id=${propertyId}`).then(r => r.data),
    enabled: !!propertyId,
  })

  // ── Recoverable expense total for selected property/year ───────────────────
  // Computed server-side over EVERY matching expense: GET /expenses returns one 50-row page, so a
  // browser-side sum silently under-stated this figure for every tenant's true-up. Keyed under
  // 'expenses' so ExpensesList's invalidateQueries(['expenses']) refreshes it after an edit.
  const yearValid = Number.isInteger(year) && year >= 2000 && year <= currentYear
  const recoverable = useQuery({
    queryKey: ['expenses', 'cam-recoverable', propertyId, year],
    queryFn: () =>
      api.get<{ data: { total: number; count: number } }>(
        `/cam/recoverable-expenses?property_id=${encodeURIComponent(propertyId)}&year=${year}`
      ).then(r => r.data),
    enabled: !!propertyId && yearValid,
  })

  // ── All CAM reconciliations ────────────────────────────────────────────────
  const { data: camRows } = useQuery({
    queryKey: ['cam'],
    queryFn: () => api.get<{ data: CAMRow[] }>('/cam').then(r => r.data),
  })

  // ── Derived values ─────────────────────────────────────────────────────────
  const activeLeases = (rentRoll ?? []).filter(r => r.lease_status === 'active')
  const totalLeasedSF = activeLeases.reduce((s, r) => s + (r.sf ?? 0), 0)

  // Only a loaded, current total may be sent to /cam/calculate — never a loading/failed/stale one.
  const recoverableReady = recoverable.isSuccess && !recoverable.isFetching
  const recoverableTotal = recoverable.data?.total ?? 0

  // ── Filtered table rows ────────────────────────────────────────────────────
  const filteredRows = (camRows ?? []).filter(row => {
    if (propertyId) {
      const propName = properties?.find(p => p.id === propertyId)?.name
      if (row.leases?.units?.properties?.name !== propName) return false
    }
    if (year && row.reconciliation_year !== year) return false
    return true
  })

  // ── Calculate reconciliation ───────────────────────────────────────────────
  async function handleCalculate() {
    if (!propertyId || !recoverableReady || activeLeases.length === 0 || totalLeasedSF === 0) return
    setCalcError(null)
    setCalculating(true)
    try {
      await Promise.all(
        activeLeases
          .filter(r => !!r.lease_id)
          .map(r =>
            api.post<{ data: CAMReconciliation }>('/cam/calculate', {
              lease_id: r.lease_id!,
              reconciliation_year: year,
              total_property_recoverable_expenses: recoverableTotal,
              total_leased_sf: totalLeasedSF,
            })
          )
      )
      await qc.invalidateQueries({ queryKey: ['cam'] })
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : 'Calculation failed.')
    } finally {
      setCalculating(false)
    }
  }

  // ── Approve & bill ─────────────────────────────────────────────────────────
  // Endpoint and payload unchanged (POST /cam/:id/approve, {}) — only the confirmation UI moved
  // from the browser confirm prompt to ConfirmDialog, and the error from a browser alert to a toast.
  async function handleApprove(row: CAMRow) {
    await runExclusive(approveInFlight, async () => {
      setApprovingId(row.id)
      try {
        await api.post<{ success: boolean; true_up_amount: number }>(`/cam/${row.id}/approve`, {})
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['cam'] }),
          qc.invalidateQueries({ queryKey: ['ar-aging'] }),
          qc.invalidateQueries({ queryKey: ['charges'] }),
        ])
        toast.success('True-up approved and posted to the tenant ledger')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Approve failed.')
      } finally {
        // Closed on failure too: re-posting a ledger charge must be a fresh, deliberate click.
        setApprovingId(null)
        setConfirmRow(null)
      }
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const canCalculate = !!propertyId && recoverableReady && totalLeasedSF > 0 && !calculating

  return (
    <div>
      <PageHeader title="CAM Reconciliation" />

      {/* ── Part 1: Run Reconciliation ── */}
      <div className="bg-white rounded-lg border border-border p-6 mb-6">
        <h2 className="text-base font-semibold text-foreground mb-4">Run Reconciliation</h2>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <Field label="Property" htmlFor="cam-property" required>
            <Select
              id="cam-property"
              value={propertyId}
              onChange={e => { setPropertyId(e.target.value); setCalcError(null) }}
            >
              <option value="">— Select property —</option>
              {(properties ?? []).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="Reconciliation Year" htmlFor="cam-year" required>
            <NumberInput
              id="cam-year"
              value={year}
              min={2000}
              max={currentYear}
              onChange={e => { setYear(Number(e.target.value)); setCalcError(null) }}
            />
          </Field>
        </div>

        {/* Summary line */}
        {propertyId && (
          <div className="mb-4">
            <p className="text-sm text-foreground">
              <span className="font-medium">Total recoverable expenses ({year}):</span>{' '}
              <span className="font-mono">{recoverableReady ? formatCurrency(recoverableTotal) : '…'}</span>
              {' · '}
              <span className="font-medium">Total leased SF:</span>{' '}
              <span className="font-mono">{totalLeasedSF.toLocaleString()}</span>
              {' · '}
              <span className="font-medium">Active tenants:</span>{' '}
              <span className="font-mono">{activeLeases.length}</span>
            </p>

            {recoverable.isError && (
              <p className="text-xs text-status-danger mt-1">
                Could not load recoverable expenses — calculation is disabled until they load.
              </p>
            )}

            {recoverableReady && recoverableTotal === 0 && (
              <p className="text-xs text-amber-600 mt-1">
                No recoverable expenses logged for this property/year — add them in Expenses (mark "Recoverable via CAM").
              </p>
            )}

            {totalLeasedSF === 0 && activeLeases.length > 0 && (
              <p className="text-xs text-status-danger mt-1">
                Active leases found but total leased SF is 0 — check unit SF values.
              </p>
            )}

            {activeLeases.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                No active leases on this property — cannot calculate.
              </p>
            )}
          </div>
        )}

        {calcError && (
          <p className="text-sm text-status-danger mb-3">{calcError}</p>
        )}

        <button
          onClick={handleCalculate}
          disabled={!canCalculate}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors
            ${canCalculate
              ? 'bg-primary text-white hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
            }`}
        >
          {calculating && (
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
            </svg>
          )}
          {calculating ? 'Calculating…' : 'Calculate Reconciliation'}
        </button>
      </div>

      {/* ── Part 2: Reconciliations table ── */}
      <div className="bg-white rounded-lg border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            Reconciliations
            {propertyId && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {properties?.find(p => p.id === propertyId)?.name ?? ''} · {year}
              </span>
            )}
          </h2>
        </div>

        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted">
            <tr>
              {['Property', 'Suite', 'Tenant', 'Year', 'Pro-rata %', 'Est. Paid', 'Actual Owed', 'True-Up', 'Status', 'Action'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                  No reconciliations yet. Run one above.
                </td>
              </tr>
            )}
            {filteredRows.map(row => {
              const trueUp = row.true_up_amount
              const isCredit = trueUp < 0
              const isApproving = approvingId === row.id

              return (
                <tr key={row.id} className="hover:bg-muted">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {row.leases?.units?.properties?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.leases?.units?.suite ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {row.leases?.tenants?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {row.reconciliation_year}
                  </td>
                  <td className="px-4 py-3 font-mono text-foreground">
                    {(row.tenant_pro_rata_share_pct * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 font-mono text-foreground">
                    {formatCurrency(row.estimated_cam_paid)}
                  </td>
                  <td className="px-4 py-3 font-mono text-foreground">
                    {formatCurrency(row.actual_cam_owed)}
                  </td>
                  <td className={`px-4 py-3 font-mono font-semibold ${isCredit ? 'text-status-active' : trueUp > 0 ? 'text-status-danger' : 'text-foreground'}`}>
                    {formatCurrency(Math.abs(trueUp))}
                    {isCredit && <span className="ml-1 text-xs font-normal">(credit)</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3">
                    {row.status === 'draft' ? (
                      <button
                        onClick={() => { setDialogRow(row); setConfirmRow(row) }}
                        disabled={isApproving}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors
                          ${isApproving
                            ? 'bg-muted text-muted-foreground cursor-not-allowed'
                            : 'bg-status-active text-white hover:bg-status-active/90'
                          }`}
                      >
                        {isApproving && (
                          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                          </svg>
                        )}
                        {isApproving ? 'Billing…' : 'Approve & Bill'}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {row.billed_date ? new Date(row.billed_date).toLocaleDateString() : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(open) => { if (!open) setConfirmRow(null) }}
        title="Approve & bill this true-up?"
        description={dialogRow && (
          dialogRow.true_up_amount < 0 ? (
            <>
              {dialogRow.leases?.tenants?.name ?? 'This tenant'} ({dialogRow.reconciliation_year}) is owed a credit of{' '}
              <span className="font-mono">{formatCurrency(Math.abs(dialogRow.true_up_amount))}</span>. Approving marks it billed
              and flags the credit for manual handling — nothing is posted to the ledger.
            </>
          ) : (
            <>
              Posts a <span className="font-mono">{formatCurrency(dialogRow.true_up_amount)}</span> true-up charge for{' '}
              {dialogRow.leases?.tenants?.name ?? 'this tenant'} ({dialogRow.reconciliation_year}) to the tenant ledger.
            </>
          )
        )}
        confirmLabel="Approve & Bill"
        pendingLabel="Billing…"
        pending={confirmRow !== null && approvingId === confirmRow.id}
        onConfirm={() => { if (confirmRow) void handleApprove(confirmRow) }}
      />
    </div>
  )
}
