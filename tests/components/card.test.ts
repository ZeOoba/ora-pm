import { describe, it, expect } from 'vitest'
import { cardClasses } from '../../src/components/ui/card'

describe('cardClasses', () => {
  it('defaults to bordered + shadow', () => {
    const c = cardClasses()
    expect(c).toContain('border')
    expect(c).toContain('rounded-card')
  })
  it('flat has no border', () => {
    expect(cardClasses('flat')).not.toContain('border')
  })
  it('raised has a larger shadow', () => {
    expect(cardClasses('raised')).toContain('shadow-lg')
  })
})
