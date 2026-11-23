// Diagnostics for a failed Anthropic Messages API call from lease intake.
//
// The intake routes deliberately return a generic message to the client ("Enter the lease manually"),
// because an upstream body may echo document text. That also hid every cause from the operator: the
// first live run of lease abstraction v2 (2026-11-23) failed with no way to tell a 400 from a 401, 429
// or 529. This logs what an operator needs to act — HTTP status, Anthropic's error type, the error
// message capped at 300 characters, and the request-id for Anthropic support — to the Worker log only
// (`wrangler pages deployment tail`). Anthropic's error messages describe request parameters, limits and
// auth, not document content; the cap bounds anything unexpected. Nothing here reaches the client.

export interface UpstreamFailure {
  status: number
  type: string | null
  message: string | null
  requestId: string | null
}

export const UPSTREAM_MESSAGE_CAP = 300

export async function describeUpstreamFailure(res: Response): Promise<UpstreamFailure> {
  let type: string | null = null
  let message: string | null = null
  try {
    const body = (await res.json()) as { error?: { type?: unknown; message?: unknown } }
    if (typeof body?.error?.type === 'string') type = body.error.type
    if (typeof body?.error?.message === 'string') message = body.error.message.slice(0, UPSTREAM_MESSAGE_CAP)
  } catch {
    // Non-JSON body (gateway error page): status and request-id are still logged.
  }
  // Diagnostics must never throw (they run on the error path): tolerate a Response-like without headers.
  let requestId: string | null = null
  try { requestId = res.headers?.get('request-id') ?? null } catch { requestId = null }
  return { status: res.status, type, message, requestId }
}

export function logUpstreamFailure(where: string, f: UpstreamFailure): void {
  console.error(`[intake] ${where}: Anthropic API ${f.status}${f.type ? ` ${f.type}` : ''}${f.message ? ` — ${f.message}` : ''}${f.requestId ? ` (request-id ${f.requestId})` : ''}`)
}
