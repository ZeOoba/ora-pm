import { describe, it, expect } from 'vitest'
import { parseTerms, containsConfidentialTerm } from '../../server/lib/confidentiality'

describe('parseTerms', () => {
  it('splits, trims, lowercases, drops blanks', () => {
    expect(parseTerms('Zeta, 99999 ,, ZZP ')).toEqual(['zeta', '99999', 'zzp'])
  })
  it('returns [] for undefined/empty', () => {
    expect(parseTerms(undefined)).toEqual([])
    expect(parseTerms('')).toEqual([])
  })
})

describe('containsConfidentialTerm', () => {
  const terms = ['zeta', '99999', 'zzp partnership']
  it('matches case-insensitively as a substring', () => {
    expect(containsConfidentialTerm('Z_Zeta_lease.pdf', terms)).toBe(true)
    expect(containsConfidentialTerm('property 99999 main', terms)).toBe(true)
    expect(containsConfidentialTerm('ZZP Partnership LLC', terms)).toBe(true)
  })
  it('does not match unrelated text', () => {
    expect(containsConfidentialTerm('Acme Logistics lease.pdf', terms)).toBe(false)
  })
  it('empty term list never matches (the route fail-closes on an empty denylist — see intake.test.ts)', () => {
    expect(containsConfidentialTerm('anything', [])).toBe(false)
  })
})
