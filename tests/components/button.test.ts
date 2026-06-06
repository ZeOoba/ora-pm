import { describe, it, expect } from 'vitest'
import { buttonClasses } from '../../src/components/ui/button-variants'

describe('buttonClasses', () => {
  it('navy is the primary (navy background)', () => {
    expect(buttonClasses('navy')).toContain('bg-navy')
  })
  it('gold variant uses gold background', () => {
    expect(buttonClasses('gold')).toContain('bg-gold')
  })
  it('ghost has no solid fill', () => {
    const c = buttonClasses('ghost')
    expect(c).not.toContain('bg-navy')
    expect(c).not.toContain('bg-gold')
  })
  it('danger uses the danger token', () => {
    expect(buttonClasses('danger')).toContain('bg-status-danger')
  })
  it('every variant has shared base classes', () => {
    for (const v of ['navy', 'gold', 'ghost', 'danger'] as const) {
      expect(buttonClasses(v)).toContain('rounded-md')
    }
  })
})
