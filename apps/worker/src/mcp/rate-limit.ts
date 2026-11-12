// Fixed-window counter per client, kept in the isolate's memory. Weaker than a shared store:
// each Worker isolate counts on its own, so the real ceiling is limit x isolates.
const WINDOW_MS = 60_000;
const MAX_KEYS = 1000;
/** Keys that arrive while the map is full share this one counter, so a flood of new keys cannot grow the map. */
export const OVERFLOW_KEY = "*overflow*";
const hits = new Map<string, { start: number; count: number }>();

/** Seconds until the caller may retry, or 0 when the call is allowed. */
export function checkRate(key: string, limit: number, now = Date.now()): number {
  if (hits.size >= MAX_KEYS && !hits.has(key)) {
    for (const [k, v] of hits) if (now - v.start >= WINDOW_MS) hits.delete(k);
    // Red-team M6: still full means a flood of fresh keys. New keys share one bucket instead of growing the map.
    if (hits.size >= MAX_KEYS) key = OVERFLOW_KEY;
  }
  const hit = hits.get(key);
  if (!hit || now - hit.start >= WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
    return 0;
  }
  hit.count += 1;
  return hit.count > limit ? Math.ceil((hit.start + WINDOW_MS - now) / 1000) : 0;
}

/**
 * The rate-limit key for a client address. An IPv6 user usually holds a whole /64 and can rotate inside it freely
 * (red-team M6), so IPv6 is keyed on its first four groups. IPv4 stays the exact address.
 */
export function clientKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::", 2);
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
