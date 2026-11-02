// Exact decimal NEAR <-> yoctoNEAR (string and BigInt math, never floats; docs/final-idea.md §11.6.2).
const YOCTO = 10n ** 24n;

/** "2.5" -> "2500000000000000000000000". Rejects more than 24 decimals, signs, exponents and spaces. */
export function nearToYocto(s: string): string {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(s);
  if (!m) throw new Error("amount_near must be a decimal like 2.5");
  return (BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0"))).toString();
}

/** "2500000000000000000000000" -> "2.5", exact (no rounding, trailing zeros dropped). */
export function yoctoToNear(y: string): string {
  const v = BigInt(y);
  const frac = (v % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / YOCTO}${frac ? "." + frac : ""}`;
}
