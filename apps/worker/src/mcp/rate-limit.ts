// Fixed-window counter per client IP, kept in the isolate's memory. Weaker than a shared store:
// each Worker isolate counts on its own, so the real ceiling is limit x isolates.
const WINDOW_MS = 60_000;
const MAX_KEYS = 1000;
const hits = new Map<string, { start: number; count: number }>();

/** Seconds until the caller may retry, or 0 when the call is allowed. */
export function checkRate(key: string, limit: number, now = Date.now()): number {
  if (hits.size > MAX_KEYS) for (const [k, v] of hits) if (now - v.start >= WINDOW_MS) hits.delete(k);
  const hit = hits.get(key);
  if (!hit || now - hit.start >= WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
    return 0;
  }
  hit.count += 1;
  return hit.count > limit ? Math.ceil((hit.start + WINDOW_MS - now) / 1000) : 0;
}
