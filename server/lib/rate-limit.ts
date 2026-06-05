// server/lib/rate-limit.ts
// In-memory rate limiter — per-IP, resets on Worker restart.
// Cloudflare Workers isolates are long-lived per-region; this is best-effort protection.

const calls = new Map<string, { count: number; windowStart: number }>()

const WINDOW_MS = 60_000  // 1 minute window
const MAX_CALLS = 5       // max 5 payment intents per IP per minute

export function checkRateLimit(ip: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now()
  const entry = calls.get(ip)

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    calls.set(ip, { count: 1, windowStart: now })
    return { allowed: true, retryAfterMs: 0 }
  }

  if (entry.count >= MAX_CALLS) {
    const retryAfterMs = WINDOW_MS - (now - entry.windowStart)
    return { allowed: false, retryAfterMs }
  }

  entry.count++
  return { allowed: true, retryAfterMs: 0 }
}
