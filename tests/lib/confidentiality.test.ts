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

describe('containsConfidentialTerm: whitespace/case normalization (intake text-layer finding)', () => {
  it('matches across line breaks, tabs and runs of spaces in the scanned text', () => {
    expect(containsConfidentialTerm('the ZZP\n   Partnership lease', ['zzp partnership'])).toBe(true)
    expect(containsConfidentialTerm('the zzp\t\tpartnership', ['zzp partnership'])).toBe(true)
  })

  it('matches across non-breaking / unicode spaces and zero-width or soft-hyphen characters', () => {
    expect(containsConfidentialTerm('ZZP\u00a0Partnership', ['zzp partnership'])).toBe(true)
    expect(containsConfidentialTerm('ZZP\u2009Partnership', ['zzp partnership'])).toBe(true)
    expect(containsConfidentialTerm('Ze\u200Bta', ['zeta'])).toBe(true)
    expect(containsConfidentialTerm('Ze\u00ADta', ['zeta'])).toBe(true)
  })

  it('matches when PDF extraction dropped the inter-word space (fail-closed bias)', () => {
    expect(containsConfidentialTerm('ZZPPartnership LLC', ['zzp partnership'])).toBe(true)
  })

  it('normalizes the roster term too: case, padding and internal whitespace runs', () => {
    expect(containsConfidentialTerm('zzp partnership', ['  ZZP    Partnership '])).toBe(true)
  })

  it('NFKC-folds compatibility characters (fullwidth letters) before matching', () => {
    expect(containsConfidentialTerm('\uFF3A\uFF45\uFF54\uFF41 lease', ['zeta'])).toBe(true)
  })

  it('a whitespace-only roster term never matches everything', () => {
    expect(containsConfidentialTerm('anything at all', ['   '])).toBe(false)
  })
})

describe('parseTerms: internal whitespace collapsed', () => {
  it('collapses internal whitespace runs in a roster term', () => {
    expect(parseTerms('ZZP   Partnership, Zeta')).toEqual(['zzp partnership', 'zeta'])
  })
})
