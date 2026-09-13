// OI-082 follow-up: request() previously discarded the response status and
// parsed body, throwing a plain Error with only the display message. That
// made a 409 `{ deduped: true }` (an idempotent retry that already recorded
// the payment, not a real failure) indistinguishable from any other error —
// a caller had no way to treat it as "settled" rather than "failed". Carries
// both through so a caller CAN branch on them; existing `.message` reads are
// unaffected since ApiError extends Error.
export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

// True when `err` is a 409 carrying `{ deduped: true }` — the shape both
// server/routes/stripe.ts and server/routes/payments.ts use to say "this
// exact request already recorded a row, nothing failed." A caller should
// treat this as settled (refetch, reset its own retry state), never as an
// error to leave sitting in front of the user.
export function isDedupedConflict(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    (err.body as { deduped?: unknown } | null)?.deduped === true
  )
}

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
