// The Yield agent's limits, kept in this browser only (no Worker or D1). They shape what the page suggests and
// nothing else: the council's vote and the code's balance checks stay exactly as they were. Creating an agent
// costs nothing on chain, so nothing here signs.
import { readAmount, tokenRaw } from "./yield-proposals.ts";

export type CheckEvery = "15m" | "1h" | "1d";
export const CHECK_EVERY: readonly CheckEvery[] = ["15m", "1h", "1d"];
export const CHECK_EVERY_TEXT: Record<CheckEvery, string> = { "15m": "15 min", "1h": "1 hour", "1d": "1 day" };
/** Used inside sentences: "every 15 minutes". */
export const CHECK_EVERY_LONG: Record<CheckEvery, string> = { "15m": "15 minutes", "1h": "hour", "1d": "day" };

export interface YieldSettings {
  /** Most it may put to work, raw token units. */
  maxPut: string;
  /** Always keep ready, raw token units, 0 or more. */
  keepReady: string;
  /** Only act above this supply rate, a fraction a year (0.04 is 4%). */
  minApr: number;
  checkEvery: CheckEvery;
  /** Always "suggest": every move is a council vote. */
  mode: "suggest";
  /** Display only: a paused agent suggests nothing. */
  paused: boolean;
}

const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

/** Anything malformed gives null, so a hand-edited or old value is never half-trusted. */
export function parseSettings(raw: unknown): YieldSettings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!digits(o.maxPut) || !digits(o.keepReady)) return null;
  if (typeof o.minApr !== "number" || !Number.isFinite(o.minApr) || o.minApr < 0 || o.minApr > 1) return null;
  if (!CHECK_EVERY.includes(o.checkEvery as CheckEvery)) return null;
  if (o.mode !== "suggest" || typeof o.paused !== "boolean") return null;
  return { maxPut: o.maxPut, keepReady: o.keepReady, minApr: o.minApr, checkEvery: o.checkEvery as CheckEvery, mode: "suggest", paused: o.paused };
}

export type LimitField = "maxPut" | "keepReady" | "minApr";
export interface LimitInput {
  maxPut: string;
  keepReady: string;
  /** Percent text: "4" or "4.5". */
  minApr: string;
}
export interface LimitContext {
  decimals: number;
  symbol: string;
  /** The most maxPut may be (raw units), or null when the balance is unknown. */
  ceiling: string | null;
}
export type LimitResult = { ok: true; maxPut: string; keepReady: string; minApr: number } | { ok: false; errors: Partial<Record<LimitField, string>> };

/** Typed limits to stored ones, or one plain message per bad field. */
export function validateSettings(input: LimitInput, ctx: LimitContext): LimitResult {
  const errors: Partial<Record<LimitField, string>> = {};
  const put = tokenRaw(input.maxPut, ctx.decimals);
  const keep = input.keepReady.trim() === "" ? "0" : tokenRaw(input.keepReady, ctx.decimals);
  if (put === null || put === "0") errors.maxPut = `Enter an amount above 0, like 12.5, with at most ${ctx.decimals} decimals.`;
  else if (ctx.ceiling !== null && BigInt(put) > BigInt(ctx.ceiling)) errors.maxPut = `That is more than the ${readAmount(ctx.ceiling, ctx.decimals)} ${ctx.symbol} this treasury has.`;
  if (keep === null) errors.keepReady = `Enter 0 or an amount like 12.5, with at most ${ctx.decimals} decimals. It cannot be negative.`;
  const pct = /^\d+(\.\d{1,2})?$/.test(input.minApr.trim()) ? Number(input.minApr.trim()) : null;
  if (pct === null || pct > 100) errors.minApr = "Enter a rate from 0 to 100, like 4 or 4.5.";
  if (Object.keys(errors).length > 0 || put === null || keep === null || pct === null) return { ok: false, errors };
  return { ok: true, maxPut: put, keepReady: keep, minApr: Math.round(pct * 100) / 10000 };
}

const key = (dao: string): string => `kd.yield.settings.${dao}`;

/** Null when nothing is saved, it is malformed, or storage is blocked: the page then runs without limits. */
export function loadSettings(dao: string): YieldSettings | null {
  try {
    const text = localStorage.getItem(key(dao));
    return text === null ? null : parseSettings(JSON.parse(text));
  } catch {
    return null;
  }
}

/** False when storage is blocked, so the caller can say the limits were not kept. */
export function saveSettings(dao: string, s: YieldSettings): boolean {
  try {
    localStorage.setItem(key(dao), JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
