import type { ThrottleLimit, ThrottleLimitResult } from './store.js'

/**
 * GCRA (the generic cell rate algorithm): each key stores one number, the "theoretical arrival
 * time". It allows `limit` requests in a burst and refills smoothly, with no fixed-window edge where
 * twice the limit gets through. Pure, so the memory store and tests share it; the Redis store runs
 * the same steps in Lua.
 */
export function gcra(limit: ThrottleLimit, tat: number | undefined, now: number, cost: number): ThrottleLimitResult & { allowed: boolean; tat: number } {
  const interval = limit.periodMs / limit.limit
  const start = Math.max(tat ?? now, now)
  const next = start + cost * interval
  const allowAt = next - limit.periodMs
  if (now < allowAt) {
    const current = Math.max(tat ?? now, now)
    return {
      allowed: false,
      tat: current,
      limit: limit.limit,
      remaining: Math.max(0, Math.floor((limit.periodMs - (current - now)) / interval)),
      resetAfterMs: Math.ceil(current - now),
      retryAfterMs: Math.ceil(allowAt - now),
    }
  }
  return {
    allowed: true,
    tat: next,
    limit: limit.limit,
    remaining: Math.max(0, Math.floor((limit.periodMs - (next - now)) / interval)),
    resetAfterMs: Math.ceil(next - now),
    retryAfterMs: 0,
  }
}
