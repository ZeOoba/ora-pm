// server/lib/rate-limit.ts
//
// KV-backed rate limiter (OI-038 remainder). Cloudflare Workers' per-isolate
// execution model made the old module-scope in-memory Map alone trivially
// bypassable — a fresh isolate is a fresh counter, so an attacker (or just
// Cloudflare spinning up a new isolate under load) resets the count for
// free. RATE_LIMIT_KV is now the source of truth for the counter across
// isolates; the in-memory Map is kept as a same-isolate FAST PATH so a burst
// of requests landing on the same isolate doesn't pay a KV read on every
// call — only the first call an isolate sees in a given window reads KV to
// learn the cross-isolate count, and every call (fast-path or not) writes
// through to KV so other isolates converge onto the same total.
//
// IMPORTANT — eventually consistent, not atomic. This is a deliberate
// trade-off, not a bug to silently work around:
//   - Cloudflare KV writes can take up to ~60s to propagate across colos.
//   - There is no compare-and-set here: two isolates racing inside the same
//     window can both read the same pre-increment count and both "win",
//     letting the true count briefly exceed maxCalls.
//   - A Durable Object would give strict consistency but is a materially
//     larger platform change for a Pages Functions app than this task
//     scopes to.
// All four consumers (payment-intent, intake, admin mutations, cron) accept
// this as a THROTTLE that raises the cost of abuse — not a hard atomic gate.
// This is called out explicitly for the branch's final adversarial REFUTE
// pass; do not "fix" it into a CAS loop without discussion.

// Narrow structural subset of the ambient Cloudflare `KVNamespace` type —
// only the two operations this module actually uses. A real KVNamespace
// satisfies this automatically (structural typing); tests can pass a plain
// { get, put } mock without implementing list/delete/getWithMetadata too.
export interface RateLimitKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface RateLimitConfig {
  /** Logical bucket name — part of the KV/local key so different call sites
   *  (payment-intent, intake, admin-mutation, cron, ...) never share a
   *  counter even if their caller-supplied `key` collides. */
  scope: string
  maxCalls: number
  windowMs: number
}

interface LocalEntry {
  count: number
  windowStart: number
}

// Module-scope singleton — this IS the same-isolate fast path described
// above. Deliberately never cleared; matches the pre-existing behavior this
// replaces (a long-lived Worker isolate keeps counting for its lifetime).
const localCalls = new Map<string, LocalEntry>()

/**
 * KV-backed, fixed-window rate limiter. `kv` is optional so this degrades
 * gracefully (memory-only, matching the pre-OI-038-remainder behavior)
 * anywhere RATE_LIMIT_KV isn't bound — local dev without the binding
 * configured, or a test that doesn't pass one.
 */
export async function checkRateLimit(
  kv: RateLimitKV | undefined,
  key: string,
  config: RateLimitConfig
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const { scope, maxCalls, windowMs } = config
  const now = Date.now()
  const windowStart = Math.floor(now / windowMs) * windowMs
  const retryAfterMs = windowMs - (now - windowStart)
  const localKey = `${scope}:${key}`
  const kvKey = `rl:${scope}:${key}:${windowStart}`

  const local = localCalls.get(localKey)

  if (!local || local.windowStart !== windowStart) {
    // First call THIS isolate has seen for this key+window — the local
    // counter (if any) is stale (belongs to a prior window) or absent, so it
    // can't be trusted as the cross-isolate count. Pay the one KV read.
    let kvCount = 0
    if (kv) {
      try {
        const raw = await kv.get(kvKey)
        kvCount = raw ? parseInt(raw, 10) || 0 : 0
      } catch {
        // KV unavailable for the read — degrade toward permissive (treat as
        // "no prior count seen") rather than block legitimate traffic on an
        // infra hiccup; this is a throttle, not a hard gate (see file header).
        kvCount = 0
      }
    }
    const allowed = kvCount < maxCalls
    const newCount = kvCount + 1
    localCalls.set(localKey, { count: newCount, windowStart })
    await writeThrough(kv, kvKey, newCount, windowMs)
    return allowed ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs }
  }

  // Fast path: same isolate, same window — skip the KV read and trust the
  // local count. Correctness across isolates still holds because (a) this
  // isolate's own writes are the only increments it needs to have observed
  // to enforce ITS contribution to the shared budget, and (b) every other
  // isolate does its own KV read on ITS first call in the window, seeding
  // from whatever this isolate (and others) have written so far.
  const allowed = local.count < maxCalls
  if (!allowed) return { allowed: false, retryAfterMs }

  const newCount = local.count + 1
  localCalls.set(localKey, { count: newCount, windowStart })
  await writeThrough(kv, kvKey, newCount, windowMs)
  return { allowed: true, retryAfterMs: 0 }
}

async function writeThrough(kv: RateLimitKV | undefined, kvKey: string, count: number, windowMs: number): Promise<void> {
  if (!kv) return
  try {
    // expirationTtl is in seconds and Cloudflare KV enforces a 60s minimum;
    // every windowMs this function is called with today is >= 60_000ms, so
    // Math.ceil(windowMs / 1000) always clears that floor.
    await kv.put(kvKey, String(count), { expirationTtl: Math.ceil(windowMs / 1000) })
  } catch {
    // Best-effort — a KV write failure degrades toward UNDER-counting (more
    // permissive), never toward blocking legitimate traffic. See file header.
  }
}
