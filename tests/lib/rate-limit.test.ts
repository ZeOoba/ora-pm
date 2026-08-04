import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RateLimitConfig } from '../../server/lib/rate-limit'

// A minimal in-memory stand-in for the KVNamespace surface checkRateLimit
// actually uses (get/put) — shared across "isolates" the same way a real
// RATE_LIMIT_KV binding would be shared across real Cloudflare isolates.
function createMockKV() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  }
}

const CONFIG: RateLimitConfig = { scope: 'test-scope', maxCalls: 5, windowMs: 60_000 }

describe('checkRateLimit — KV-backed durability across isolates (OI-038 remainder)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // RED 1: a mock KV shared across two separately-instantiated limiter
  // modules (simulating two Worker isolates, each with its own fresh
  // module-scope in-memory Map) — the 6th call within a window across BOTH
  // must be denied. Fails against the pre-Task-6 memory-only limiter,
  // because each "isolate" (fresh module instance) starts its own counter
  // at 0 and neither would ever see the other's calls.
  it('denies the 6th call within a window across two isolates sharing one KV', async () => {
    const kv = createMockKV()

    vi.resetModules()
    const isolateA = await import('../../server/lib/rate-limit')
    vi.resetModules()
    const isolateB = await import('../../server/lib/rate-limit')

    const outcomes: boolean[] = []
    for (let i = 0; i < 3; i++) {
      outcomes.push((await isolateA.checkRateLimit(kv, 'shared-key', CONFIG)).allowed)
    }
    for (let i = 0; i < 3; i++) {
      outcomes.push((await isolateB.checkRateLimit(kv, 'shared-key', CONFIG)).allowed)
    }

    // Calls 1-5 (3 from isolate A, then 2 from isolate B) allowed; the 6th
    // call overall — isolate B's 3rd — is denied because KV now reflects
    // the true cross-isolate total of 5.
    expect(outcomes).toEqual([true, true, true, true, true, false])
    expect(kv.store.size).toBe(1) // single fixed-window bucket for this key
  })

  it('a fresh isolate seeded from KV still enforces the limit even for its very first call', async () => {
    const kv = createMockKV()
    const isolateA = await import('../../server/lib/rate-limit')
    for (let i = 0; i < 5; i++) await isolateA.checkRateLimit(kv, 'k', CONFIG)

    vi.resetModules()
    const isolateB = await import('../../server/lib/rate-limit')
    const result = await isolateB.checkRateLimit(kv, 'k', CONFIG)
    expect(result.allowed).toBe(false)
  })

  it('same isolate, same window: only the first call reads KV (fast path)', async () => {
    const kv = createMockKV()
    const { checkRateLimit } = await import('../../server/lib/rate-limit')

    for (let i = 0; i < 4; i++) await checkRateLimit(kv, 'fast-path-key', CONFIG)

    expect(kv.get).toHaveBeenCalledTimes(1)
    // Every call still writes through, so other isolates converge.
    expect(kv.put).toHaveBeenCalledTimes(4)
  })

  it('different scopes never share a counter even with the same key', async () => {
    const kv = createMockKV()
    const { checkRateLimit } = await import('../../server/lib/rate-limit')

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(kv, 'same-key', { scope: 'scope-a', maxCalls: 5, windowMs: 60_000 })
      expect(r.allowed).toBe(true)
    }
    // scope-b's bucket for the same key is untouched by scope-a's calls.
    const r = await checkRateLimit(kv, 'same-key', { scope: 'scope-b', maxCalls: 5, windowMs: 60_000 })
    expect(r.allowed).toBe(true)
  })

  it('degrades to memory-only (never throws) when kv is undefined', async () => {
    const { checkRateLimit } = await import('../../server/lib/rate-limit')
    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimit(undefined, 'no-kv-key', CONFIG)).allowed).toBe(true)
    }
    expect((await checkRateLimit(undefined, 'no-kv-key', CONFIG)).allowed).toBe(false)
  })

  it('a new window resets the count', async () => {
    vi.useFakeTimers()
    try {
      const kv = createMockKV()
      const { checkRateLimit } = await import('../../server/lib/rate-limit')
      const cfg: RateLimitConfig = { scope: 'window-reset', maxCalls: 2, windowMs: 60_000 }

      vi.setSystemTime(0)
      expect((await checkRateLimit(kv, 'k', cfg)).allowed).toBe(true)
      expect((await checkRateLimit(kv, 'k', cfg)).allowed).toBe(true)
      expect((await checkRateLimit(kv, 'k', cfg)).allowed).toBe(false)

      vi.setSystemTime(60_001) // next window
      expect((await checkRateLimit(kv, 'k', cfg)).allowed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
