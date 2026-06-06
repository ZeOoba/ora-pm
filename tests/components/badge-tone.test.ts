import { describe, it, expect } from 'vitest'
import { statusTone } from '../../src/components/ui/badge-tone'

describe('statusTone', () => {
  it('maps positive statuses to active', () => {
    expect(statusTone('active')).toBe('active')
    expect(statusTone('collected')).toBe('active')
    expect(statusTone('executed')).toBe('active')
    expect(statusTone('paid')).toBe('active')
  })
  it('maps risk statuses to danger', () => {
    expect(statusTone('overdue')).toBe('danger')
    expect(statusTone('terminated')).toBe('danger')
    expect(statusTone('missing')).toBe('danger')
    expect(statusTone('declined')).toBe('danger')
  })
  it('maps soft-warning statuses to warning', () => {
    expect(statusTone('expiring_soon')).toBe('warning')
    expect(statusTone('notice')).toBe('warning')
    expect(statusTone('urgent')).toBe('warning')
    expect(statusTone('negotiating')).toBe('warning')
  })
  it('maps in-progress statuses to pending/info', () => {
    expect(statusTone('pending')).toBe('pending')
    expect(statusTone('proposal_sent')).toBe('info')
    expect(statusTone('occupied')).toBe('info')
  })
  it('falls back to neutral for unknown', () => {
    expect(statusTone('totally_unknown')).toBe('neutral')
    expect(statusTone('vacant')).toBe('neutral')
    expect(statusTone('draft')).toBe('neutral')
  })
})
