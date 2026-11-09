import { describe, it, expect } from 'vitest'
import { resolvePreset, isPreset, toIsoDate, DATE_PRESETS } from '../../src/lib/date-range'

// Local-time construction: presets must follow the user's calendar day, not UTC.
const NOV9 = new Date(2026, 10, 9, 23, 30)

describe('resolvePreset', () => {
  it('month-to-date', () => {
    expect(resolvePreset('mtd', NOV9)).toEqual({ from: '2026-11-01', to: '2026-11-09', label: 'Month-to-date (Nov 2026)' })
  })
  it('last month', () => {
    expect(resolvePreset('last_month', NOV9)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' })
  })
  it('last month across a year boundary', () => {
    expect(resolvePreset('last_month', new Date(2026, 0, 15))).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
  })
  it('quarter-to-date', () => {
    expect(resolvePreset('qtd', NOV9)).toMatchObject({ from: '2026-10-01', to: '2026-11-09' })
  })
  it('year-to-date', () => {
    expect(resolvePreset('ytd', NOV9)).toMatchObject({ from: '2026-01-01', to: '2026-11-09' })
  })
  it('last year', () => {
    expect(resolvePreset('last_year', NOV9)).toMatchObject({ from: '2025-01-01', to: '2025-12-31' })
  })
  it('trailing 12 months', () => {
    expect(resolvePreset('t12', NOV9)).toMatchObject({ from: '2025-12-01', to: '2026-11-09' })
  })
  it('handles leap-year February as last month', () => {
    expect(resolvePreset('last_month', new Date(2028, 2, 3))).toMatchObject({ from: '2028-02-01', to: '2028-02-29' })
  })
})

describe('helpers', () => {
  it('toIsoDate uses local calendar fields', () => {
    expect(toIsoDate(NOV9)).toBe('2026-11-09')
  })
  it('isPreset narrows only known keys', () => {
    expect(isPreset('mtd')).toBe(true)
    expect(isPreset('custom')).toBe(false)
    expect(isPreset(null)).toBe(false)
  })
  it('every preset has a label', () => {
    for (const p of DATE_PRESETS) expect(p.label.length).toBeGreaterThan(0)
  })
})
