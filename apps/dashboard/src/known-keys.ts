// "That was me": public keys the viewer says they added, remembered per account in this browser only.
// Display state: nothing goes on chain, and blocked storage simply turns the feature off.

const storageKey = (account: string): string => `kd.keys.known.${account}`;

export function loadKnown(account: string): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey(account)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** Returns the set after the write; unchanged when storage is blocked, so the banner never lies about what was saved. */
export function markKnown(account: string, publicKey: string): Set<string> {
  const known = loadKnown(account);
  if (known.has(publicKey)) return known;
  const next = new Set(known).add(publicKey);
  try {
    localStorage.setItem(storageKey(account), JSON.stringify([...next]));
    return next;
  } catch {
    return known;
  }
}
