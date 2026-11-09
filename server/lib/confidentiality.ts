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
// blocking, which is the safe direction for a pre-egress gate.

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

/** Letters and digits only (any script). REFUTE C1c: stripping only spaces missed terms split by a
 *  line-break hyphen ("Blue-\nridge") or punctuated ("B.L.U.E..."). Applied to BOTH sides; it can
 *  only add matches, the safe direction for a pre-egress gate. */
function compact(normalized: string): string {
  return normalized.replace(/[^\p{L}\p{N}]/gu, '')
}

/** True if `text` contains any denylist term (normalized substring match; see header). */
export function containsConfidentialTerm(text: string, terms: string[]): boolean {
  const hay = normalizeForMatch(text)
  const hayCompact = compact(hay)
  return terms.some((raw) => {
    const term = normalizeForMatch(raw)
    if (!term) return false
    const termCompact = compact(term)
    return hay.includes(term) || (termCompact.length > 0 && hayCompact.includes(termCompact))
  })
}
