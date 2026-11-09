// Confidential-term denylist matching for the lease-intake pre-egress scan.
//
// Both sides of the comparison are normalized the same way before matching, so
// formatting noise from PDF text extraction can't split a roster term past the
// scan (audit finding intake-partial-text-layer-egress):
//   1. NFKC  : folds compatibility forms (fullwidth letters, ligatures) to plain text.
//   2. strip : zero-width characters, soft hyphens and the BOM, which pdf.js can
//              emit inside a word and which are not matched by \s.
//   3. lower : case-insensitive.
//   4. collapse: every run of whitespace (incl. NBSP / thin / other Unicode
//              spaces, line breaks, tabs) to one ASCII space.
// A term is then matched as a substring of the normalized text, AND of the
// normalized text with every non-letter/non-digit removed against the term
// reduced the same way. The second form catches extraction that dropped an
// inter-word space ("ZZPPartnership"), a line-break hyphen ("Blue-\nridge") or
// punctuation ("B.L.U.E"); it can only ADD matches, i.e. it biases toward
// blocking, which is the safe direction for a pre-egress gate. The compact form also strips
// combining marks after NFKD and folds Cyrillic/Greek Latin-lookalikes (E1), see compact().

const INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g
const WHITESPACE_RUN_RE = /\s+/g

/** Normalize text or a roster term for matching (see header). */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .toLowerCase()
    .replace(WHITESPACE_RUN_RE, ' ')
    .trim()
}

/** Parse the comma-separated CONFIDENTIAL_TERMS env value into a normalized list. */
export function parseTerms(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map(normalizeForMatch).filter(Boolean)
}

// E1 (PR #53 REFUTE follow-up): Latin-lookalike letters from Cyrillic and Greek, folded to the
// Latin letter they imitate. Keyed on the ORIGINAL case because the two cases of one letter can
// imitate different Latin letters (Greek "Η" looks like H, "η" like n; Cyrillic "В" like B). This
// is a hand-checked SUBSET of Unicode confusables.txt (Cyrillic, Greek, Armenian, Cherokee, Latin
// small capitals and Latin variants), not a full UTS #39 skeleton: a lookalike from a script not
// listed here still passes. It can only ADD matches (the fail-closed direction).
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic, upper
  А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', У: 'y',
  Х: 'x', Ѕ: 's', І: 'i', Ј: 'j', Ү: 'y', Һ: 'h', Ӏ: 'l', Ԛ: 'q', Ԝ: 'w',
  // Cyrillic, lower
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ь: 'b', ѕ: 's', і: 'i', ј: 'j', ү: 'y', һ: 'h', ӏ: 'l', ԁ: 'd', ԛ: 'q', ԝ: 'w', г: 'r',
  // Greek, upper
  Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't',
  Υ: 'y', Χ: 'x',
  // Greek, lower
  α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u',
  χ: 'x', ω: 'w', σ: 'o',
  // Armenian, lower
  օ: 'o', ս: 'u', հ: 'h', ո: 'n', ց: 'g', զ: 'q',
  // Cherokee, upper (rendered like Latin capitals)
  Ꭺ: 'a', Ᏼ: 'b', Ꮯ: 'c', Ꭰ: 'd', Ꭼ: 'e', Ꮐ: 'g', Ꮋ: 'h', Ꭻ: 'j', Ꮶ: 'k', Ꮮ: 'l', Ꮇ: 'm',
  Ꮲ: 'p', Ꮪ: 's', Ꭲ: 't', Ꮩ: 'v', Ꮃ: 'w', Ꮓ: 'z',
  // Latin small capitals
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l',
  ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
  // Latin variants NFKD leaves alone
  ı: 'i', ȷ: 'j', ɡ: 'g',
}
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu')
const COMBINING_MARK_RE = /\p{M}/gu

/** Letters and digits only (any script), with marks stripped and homoglyphs folded to Latin.
 *  REFUTE C1c: stripping only spaces missed terms split by a line-break hyphen ("Blue-\nridge")
 *  or punctuated ("B.L.U.E..."). E1: NFKC composes "e" + U+0301 into "é", which is a letter and
 *  survived; NFKD then stripping \p{M} reduces every accented or mark-stacked letter to its base,
 *  and CONFUSABLES folds Cyrillic/Greek lookalikes. Takes the RAW text (so the case-aware fold sees
 *  the original case) and is applied to BOTH sides; it can only add matches, the safe direction
 *  for a pre-egress gate. */
function foldedCompact(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .normalize('NFKD')
    .replace(COMBINING_MARK_RE, '')
    .replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** The pre-E1 compact form: letters and digits only of the NFKC-normalized text. Kept as its own
 *  comparison because the case-aware fold above is not case-symmetric (Greek "Η"->h, "η"->n), so
 *  an upper-case Greek/Cyrillic name split by a hyphen matched here but not in the folded form
 *  (REFUTE finding). OR-ing both keeps E1 strictly additive. */
function plainCompact(normalized: string): string {
  return normalized.replace(/[^\p{L}\p{N}]/gu, '')
}

/** True if `text` contains any denylist term (normalized substring match; see header). */
export function containsConfidentialTerm(text: string, terms: string[]): boolean {
  const hay = normalizeForMatch(text)
  const hayPlain = plainCompact(hay)
  const hayFolded = foldedCompact(text)
  return terms.some((raw) => {
    const term = normalizeForMatch(raw)
    if (!term) return false
    if (hay.includes(term)) return true
    const termPlain = plainCompact(term)
    if (termPlain.length > 0 && hayPlain.includes(termPlain)) return true
    const termFolded = foldedCompact(raw)
    return termFolded.length > 0 && hayFolded.includes(termFolded)
  })
}
