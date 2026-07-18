import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression guard for the 2026-07-16 audit finding #7 (re-confirmed by REFUTE pass 2026-07-18):
// PortalPayNow.tsx and PortalDashboard.tsx both read `ch.charge_type` (a field that never
// existed on the `charges` table — the real column is `type`) and filtered on
// `ch.status === 'open'` (charges has no `status` column at all). The status filter silently
// zeroed the open-charges list on every load, which is why the `.charge_type.replace(...)` call
// — that throws on any charge lacking a description — never actually fired in production; fixing
// only the field name without also removing the dead filter would leave the Pay Now flow
// non-functional. No React-rendering test harness exists in this repo (see
// portal-dashboard-no-cents-division.test.ts), so this reads the component source directly.
describe('Portal charge fields — no reintroduced charge_type/status drift', () => {
  const payNowSource = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalPayNow.tsx'),
    'utf-8'
  )
  const dashboardSource = readFileSync(
    join(__dirname, '../../src/portal/pages/PortalDashboard.tsx'),
    'utf-8'
  )

  it('PortalPayNow does not reference the non-existent charge_type/status fields', () => {
    expect(payNowSource).not.toMatch(/charge_type/)
    expect(payNowSource).not.toMatch(/\.status\s*===\s*['"]open['"]/)
  })

  it('PortalPayNow derives the charge label from the real `type` column', () => {
    expect(payNowSource).toMatch(/ch\.description\s*\?\?\s*ch\.type\.replace/)
  })

  it('PortalDashboard does not reference the non-existent charge_type/status fields', () => {
    expect(dashboardSource).not.toMatch(/charge_type/)
    expect(dashboardSource).not.toMatch(/\.status\s*===\s*['"]open['"]/)
  })

  it('PortalDashboard derives the charge label from the real `type` column', () => {
    expect(dashboardSource).toMatch(/c\.description\s*\?\?\s*c\.type/)
  })
})
