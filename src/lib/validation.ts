// Same pattern zod's `.email()` uses (zod v3 types.js `emailRegex`), which is
// what the server's contact_email schema (server/lib/schemas.ts) enforces — so
// a value the form accepts is never rejected by the API with a 422. Copied
// rather than importing zod, which would add ~54 KB to the shared client
// bundle; tests/lib/tenant-email-validation.test.ts checks parity against the
// live server schema, so a zod upgrade that changes the rule fails there.
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value)
}
