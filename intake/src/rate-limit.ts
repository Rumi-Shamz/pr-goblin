// rate-limit.ts — a small fixed-window limiter, kept in memory.
//
// Good enough for a single Node process, which is what `node.ts` runs. It is
// not used on Cloudflare Workers, where memory is not shared between
// isolates: use Cloudflare's own rate limiting rules there.

export interface RateLimiter {
  /** True when the caller may proceed. */
  allow(key: string, now?: number): boolean
}

export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const { limit, windowMs, maxKeys = 10_000 } = opts
  const hits = new Map<string, { count: number; resetAt: number }>()

  return {
    allow(key, now = Date.now()) {
      const entry = hits.get(key)
      if (!entry || now >= entry.resetAt) {
        // Bound memory: drop expired windows before the map grows without limit.
        if (hits.size >= maxKeys) {
          for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k)
          if (hits.size >= maxKeys) hits.clear()
        }
        hits.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      entry.count++
      return entry.count <= limit
    },
  }
}
