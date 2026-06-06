/** Parse the comma-separated CONFIDENTIAL_TERMS env value into a normalized list. */
export function parseTerms(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
}

/** True if `text` contains any denylist term (case-insensitive substring). */
export function containsConfidentialTerm(text: string, terms: string[]): boolean {
  const hay = text.toLowerCase()
  return terms.some(term => hay.includes(term))
}
