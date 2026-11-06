import { describe, it, expect } from 'vitest'
import { cn } from '../../src/lib/utils'

describe('cn', () => {
  it('merges conflicting tailwind classes, last wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })
  it('filters falsy values', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b')
  })
  it('supports conditional object syntax', () => {
    expect(cn('a', { b: true, c: false })).toBe('a b')
  })
})
