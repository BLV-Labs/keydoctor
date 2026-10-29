const encoder = new TextEncoder();

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}

/**
 * Checks `Authorization: Bearer <expected>` in constant time (both sides are hashed first).
 * A missing or empty secret denies every request.
 */
export async function hasBearer(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const [a, b] = await Promise.all([digest(match[1] as string), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
