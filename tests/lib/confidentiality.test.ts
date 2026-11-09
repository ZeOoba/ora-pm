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

// REFUTE C1c: the compact (space-stripped) form missed terms split by a line-break hyphen or
// punctuation. The compact form now strips every non-letter/non-digit on both sides.
describe('containsConfidentialTerm: punctuation-insensitive compact match (REFUTE C1c)', () => {
  const terms = parseTerms('Blueridge Partners,ZZ Holdings')
  it('matches a term split by a line-break hyphen', () => {
    expect(containsConfidentialTerm('This lease is made between Blue-\nridge Partners and Tenant LLC.', terms)).toBe(true)
  })
  it('matches dotted / punctuated spellings', () => {
    expect(containsConfidentialTerm('B.L.U.E.R.I.D.G.E', parseTerms('BLUERIDGE'))).toBe(true)
    expect(containsConfidentialTerm('Blueridge-Partners', terms)).toBe(true)
    expect(containsConfidentialTerm('Blue Ridge Partners', terms)).toBe(true)
    expect(containsConfidentialTerm('Z.Z. Holdings', terms)).toBe(true)
  })
  it('a punctuation-only roster term never matches everything', () => {
    expect(containsConfidentialTerm('anything at all', ['-.-'])).toBe(false)
  })
  it('still does not match unrelated text', () => {
    expect(containsConfidentialTerm('Acme Logistics lease for Suite 4', terms)).toBe(false)
  })
})

// E1 (PR #53 REFUTE follow-up): NFKC COMPOSES a base letter plus a combining mark ("e" + U+0301 ->
// "é"), and "é" is a letter, so the compact form kept it and "Zéta" slipped past the term "zeta".
// Cyrillic / Greek Latin-lookalikes (U+0430 "а", U+043E "о", U+0435 "е", U+03BF "ο", ...) also
// passed through. The compact form now decomposes (NFKD), strips every combining mark and folds a
// confusables table to Latin on BOTH sides. The plain NFKC substring path is unchanged.
describe('containsConfidentialTerm: combining marks and homoglyphs (E1)', () => {
  const terms = parseTerms('Zephyr Corp,Zeta')

  it('blocks a term spelled with combining accents (decomposed form)', () => {
    expect(containsConfidentialTerm('Ze\u0301phyr Corp lease', terms)).toBe(true)
    expect(containsConfidentialTerm('Z\u0301e\u0301t\u0301a\u0301 Holdings', terms)).toBe(true)
    expect(containsConfidentialTerm('Ze\u0308\u0323ta', terms)).toBe(true) // stacked marks
  })

  it('blocks a term spelled with precomposed accented letters', () => {
    expect(containsConfidentialTerm('Zéphyr Cörp', terms)).toBe(true)
    expect(containsConfidentialTerm('ZÉTA', terms)).toBe(true)
  })

  it('blocks Cyrillic homoglyphs (lower and upper case)', () => {
    expect(containsConfidentialTerm('Z\u0435t\u0430 lease', terms)).toBe(true) // е, а
    expect(containsConfidentialTerm('Z\u0435\u0440hyr C\u043Er\u0440', terms)).toBe(true) // Cyrillic e, er, o, er
    expect(containsConfidentialTerm('ZEPHYR \u0421\u041ER\u0420', terms)).toBe(true) // Cyrillic upper Es, O, Er
  })

  it('blocks Greek homoglyphs, including the upper-case Zeta that is identical to Latin Z', () => {
    expect(containsConfidentialTerm('\u0396\u0395\u03A4\u0391', terms)).toBe(true) // Ζ Ε Τ Α
    expect(containsConfidentialTerm('Zeph\u03B3r C\u03BFrp', terms)).toBe(true) // γ, ο
  })

  it('blocks a mixed attack: homoglyph + combining mark + zero-width + punctuation', () => {
    expect(containsConfidentialTerm('Z\u0435\u0301\u200B\u0440.h-yr C\u043Er\u0440', terms)).toBe(true)
  })

  it('still matches a roster term that itself carries accents against plain text', () => {
    expect(containsConfidentialTerm('Cafe Holdings LLC', parseTerms('Café Holdings'))).toBe(true)
  })

  it('a combining-mark-only roster term never matches everything', () => {
    expect(containsConfidentialTerm('anything at all', ['\u0301\u0308'])).toBe(false)
  })

  it('does not match unrelated text that merely shares scripts', () => {
    expect(containsConfidentialTerm('Москва warehouse, Αθήνα annex, Acme Logistics', terms)).toBe(false)
  })
})

// REFUTE (E1) finding: the case-aware fold maps the two cases of some letters differently (Greek
// "Η"->h but "η"->n), and parseTerms lower-cases the roster term while the text keeps its case.
// An upper-case Greek/Cyrillic party name broken by a hyphen or line break was blocked before E1
// and slipped through after it. The pre-E1 compact comparison is kept as an extra OR, so E1 can
// only ADD matches.
describe('containsConfidentialTerm: E1 never loses a match the pre-E1 matcher caught', () => {
  it.each([
    ['ηρακλης', 'ΗΡΑ-ΚΛΗΣ'],
    ['сибирь', 'СИБИ-РЬ'],
    ['νικη', 'ΝΙ-\nΚΗ'],
  ])('term %s is still blocked in hyphen/line-split upper-case text %s', (term, text) => {
    expect(containsConfidentialTerm(text, parseTerms(term))).toBe(true)
  })

  it('blocks further lookalike scripts: Armenian, Latin small capitals, Cherokee, Cyrillic ge, Greek sigma', () => {
    const terms = parseTerms('Zephyr Corp')
    expect(containsConfidentialTerm('Zephyr C\u0585rp', terms)).toBe(true) // Armenian oh
    expect(containsConfidentialTerm('Zep\u0570yr Corp', terms)).toBe(true) // Armenian ho
    expect(containsConfidentialTerm('Zephy\u0280 C\u1D0F\u0280p', terms)).toBe(true) // small capital R, O
    expect(containsConfidentialTerm('\u13C3ephyr Corp', terms)).toBe(true) // Cherokee letter that renders as Z
    expect(containsConfidentialTerm('Zephy\u0433 Co\u0433p', terms)).toBe(true) // Cyrillic ge used as r
    expect(containsConfidentialTerm('Zephyr C\u03C3rp', terms)).toBe(true) // Greek sigma used as o
  })
})
