import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Source-level pins (node env, no jsdom — see global constraints) for the double-submit guards and
// the dialog-text-flicker fix on the ConfirmDialog flows.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fnBody = (src: string, header: RegExp) => {
  const m = header.exec(src)
  expect(m, String(header)).not.toBeNull()
  return src.slice(m!.index, m!.index + 1500)
}

describe('CAM approve', () => {
  const src = read('../../src/pages/cam/CAMList.tsx')
  it('has a synchronous in-flight ref checked/set at the top and cleared in finally', () => {
    expect(src).toMatch(/const approveInFlight = useRef\(false\)/)
    const body = fnBody(src, /async function handleApprove\(/)
    expect(body).toMatch(/if \(approveInFlight\.current\) return\s+approveInFlight\.current = true\s+setApprovingId/)
    expect(body).toMatch(/finally \{\s*(\/\/[^\n]*\n\s*)*approveInFlight\.current = false/)
  })
  it('endpoint, payload and invalidations unchanged', () => {
    expect(src).toContain('api.post<{ success: boolean; true_up_amount: number }>(`/cam/${row.id}/approve`, {})')
    for (const k of ['cam', 'ar-aging', 'charges']) expect(src).toContain(`qc.invalidateQueries({ queryKey: ['${k}'] })`)
  })
  it('dialog text is derived from the last confirmed row so it does not blank on close', () => {
    expect(src).toMatch(/lastConfirmRow\.current = confirmRow/)
    expect(src).toMatch(/const dialogRow = confirmRow \?\? lastConfirmRow\.current/)
    const dlg = src.slice(src.indexOf('<ConfirmDialog'))
    expect(dlg).toMatch(/description=\{dialogRow &&/)
    expect(dlg.slice(0, dlg.indexOf('confirmLabel'))).not.toContain('confirmRow.')
  })
})

describe('Expenses delete', () => {
  const src = read('../../src/pages/expenses/ExpensesList.tsx')
  it('has a synchronous in-flight ref checked/set at the top and cleared in finally', () => {
    expect(src).toMatch(/const deleteInFlight = useRef\(false\)/)
    const body = fnBody(src, /async function confirmDelete\(/)
    expect(body).toMatch(/if \(!deleteId \|\| deleteInFlight\.current\) return\s+deleteInFlight\.current = true\s+setDeleting\(true\)/)
    expect(body).toMatch(/finally \{\s*deleteInFlight\.current = false/)
  })
  it('endpoint and invalidation unchanged', () => {
    expect(src).toContain('api.del(`/expenses/${deleteId}`)')
    expect(src).toContain("qc.invalidateQueries({ queryKey: ['expenses'] })")
  })
  it('dialog text is static (nothing derived from the nulled deleteId)', () => {
    const dlg = src.slice(src.indexOf('<ConfirmDialog'))
    expect(dlg.slice(0, dlg.indexOf('confirmLabel'))).not.toMatch(/description=\{/)
  })
})

describe('TenantPortalAdmin revoke', () => {
  it('dialog text comes from the tenant prop, not from state cleared on close', () => {
    const src = read('../../src/pages/admin/TenantPortalAdmin.tsx')
    const dlg = src.slice(src.indexOf('<ConfirmDialog'))
    expect(dlg).toContain('description={`${tenant.name} will be signed out')
  })
})
