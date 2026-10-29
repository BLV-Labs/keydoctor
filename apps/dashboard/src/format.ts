import type { KeyInfo } from "key-doctor";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const YOCTO_PER_NEAR = 10n ** 24n;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const formatInt = (n: number): string => n.toLocaleString("en-US");

/** "Nov 3, 2026, 02:00 UTC". Formatted by hand so every browser prints the same text. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "ed25519:7Hq2…Vd9K" */
export function truncateKey(publicKey: string): string {
  const i = publicKey.indexOf(":");
  const curve = i >= 0 ? publicKey.slice(0, i + 1) : "";
  const body = i >= 0 ? publicKey.slice(i + 1) : publicKey;
  return body.length <= 10 ? publicKey : `${curve}${body.slice(0, 4)}…${body.slice(-4)}`;
}

/** yoctoNEAR string to a NEAR amount without float rounding: "100000000000000000000000" → "0.1". */
export function yoctoToNear(yocto: string): string {
  if (!/^\d+$/.test(yocto)) return "unknown";
  const v = BigInt(yocto);
  const whole = v / YOCTO_PER_NEAR;
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Milliseconds between the key's estimated creation and the scanned block, or null when unknown. */
export function keyAgeMs(key: KeyInfo, blockTimestamp: string): number | null {
  if (key.created.at === null) return null;
  const ms = Date.parse(blockTimestamp) - Date.parse(key.created.at);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

export function relativeAge(ms: number | null): string {
  if (ms === null) return "Unknown";
  if (ms < MS_PER_HOUR) return "Less than an hour ago";
  if (ms < 2 * MS_PER_DAY) {
    const h = Math.floor(ms / MS_PER_HOUR);
    return `About ${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(ms / MS_PER_DAY);
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `About ${Math.floor(days / 30.44)} months ago`;
  return `About ${Math.floor(days / 365.25)} years ago`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${formatInt(n)} ${n === 1 ? one : many}`;

/** Sputnik thresholds are `[n, d]` (ratio) or a number/string (weight); anything else is shown as raw JSON. */
export function formatThreshold(threshold: unknown): string {
  if (Array.isArray(threshold) && threshold.length === 2) return `Ratio ${threshold[0]}/${threshold[1]}`;
  if (typeof threshold === "number" || typeof threshold === "string") return `Weight ${threshold}`;
  return JSON.stringify(threshold) ?? "unknown";
}
