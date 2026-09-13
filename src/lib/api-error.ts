// Turns an API error body into display text. Routes return either
// `{ error: string }` or, on a 422, `{ error: zod fieldErrors }` —
// e.g. `{ contact_email: ['Invalid email'] }` — which must not reach the UI
// as `[object Object]`.
export function apiErrorMessage(body: unknown, statusText: string): string {
  const error = (body as { error?: unknown } | null)?.error
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object') {
    const parts = Object.entries(error as Record<string, unknown>)
      .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
      .map(([field, msgs]) => `${field}: ${(msgs as unknown[]).join(', ')}`)
    if (parts.length > 0) return parts.join('; ')
  }
  return statusText
}
