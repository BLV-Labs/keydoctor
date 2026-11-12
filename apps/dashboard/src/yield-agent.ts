// What the Yield agent says and suggests, pure. The limits shape the display only: the council still votes on
// every move, and yield-proposals.ts still checks any amount against the real available balance.
import { bestSupply, type RheaPool } from "key-doctor";
import type { RawPolicy } from "./guard-proposals.ts";
import { GUARD_ROLE } from "./guard-proposals.ts";
import { CHECK_EVERY_LONG, type YieldSettings } from "./yield-settings.ts";
import { readAmount } from "./yield-proposals.ts";

/** A fraction a year as a short percent: 0.04 is "4", 0.0425 is "4.25". */
export const pctText = (fraction: number): string => (fraction * 100).toFixed(2).replace(/\.?0+$/, "");

/** The most to put to work now: min(idle - keepReady, maxPut - alreadySupplied), never below 0. All raw units. */
export function suggestedAmount(idle: bigint, supplied: bigint, limits: { maxPut: bigint; keepReady: bigint }): bigint {
  const free = idle - limits.keepReady;
  const room = limits.maxPut - supplied;
  const least = free < room ? free : room;
  return least > 0n ? least : 0n;
}

/** `all` is set only when the amount was lowered to the best one: what putting everything in would have been. */
export type Suggestion = { kind: "register" | "supply"; amount: string; all?: string } | { kind: "nothing"; reason: string };

export interface SuggestInput {
  settings: YieldSettings | null;
  /** Supply rate now, a fraction; null when there is no row for the token. */
  apr: number | null;
  /** Available to put to work (balance minus open transfers), raw; null when unread. */
  idle: string | null;
  /** Already on Rhea Lend, raw; null when unread. */
  supplied: string | null;
  registered: boolean | null;
  /** Rhea Lend's pool for the token; with it the amount is capped at what earns the treasury the most. */
  pool?: RheaPool | null;
  decimals: number;
  symbol: string;
}

/**
 * The next move, or why there is none. Reasons are checked in a fixed order so the card always names the first
 * thing in the way: paused, rate below the floor, nothing idle beyond what is kept ready, limit reached, more would
 * earn less. Each deposit lowers the rate for the whole pool, so past a point more money earns the treasury less.
 */
export function suggest(i: SuggestInput): Suggestion {
  const s = i.settings;
  const nothing = (reason: string): Suggestion => ({ kind: "nothing", reason });
  if (s?.paused) return nothing("paused. Resume to get suggestions again.");
  if (s !== null && i.apr !== null && i.apr < s.minApr) return nothing(`the rate is below your floor (${pctText(i.apr)}% < ${pctText(s.minApr)}%).`);
  if (i.idle === null) return nothing("the treasury's balance could not be read.");
  const idle = BigInt(i.idle);
  const keep = s === null ? 0n : BigInt(s.keepReady);
  if (idle - keep <= 0n) return nothing(s !== null && keep > 0n ? "nothing is idle beyond what you keep ready." : "nothing is idle.");
  let amount = idle - keep;
  if (s !== null) {
    if (i.supplied === null) return nothing("the amount already on Rhea Lend could not be read.");
    amount = suggestedAmount(idle, BigInt(i.supplied), { maxPut: BigInt(s.maxPut), keepReady: keep });
    if (amount <= 0n) return nothing("your limit on what to put to work is reached.");
  }
  if (i.registered === null) return nothing("registration with Rhea Lend could not be read.");
  const kind = i.registered ? "supply" : "register";
  if (i.pool != null && i.supplied !== null) {
    const best = bestSupply(i.pool, BigInt(i.supplied), amount, i.decimals);
    if (best === 0n) return nothing("putting more in would lower what the treasury earns. Each deposit lowers the rate for the whole pool.");
    if (best < amount) return { kind, amount: best.toString(), all: amount.toString() };
  }
  return { kind, amount: amount.toString() };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Council votes a "call" needs: the first non-guard Group role's policy for it, else the DAO default. Null if unknown. */
export function votesNeeded(policy: RawPolicy | null): number | null {
  if (policy === null) return null;
  const role = policy.roles.find((r) => r.name !== GUARD_ROLE && isObj(r.kind) && Array.isArray(r.kind.Group));
  if (role === undefined) return null;
  const size = (role.kind as { Group: unknown[] }).Group.length;
  const own = isObj(role.vote_policy) ? role.vote_policy.call : undefined;
  const vp = isObj(own) ? own : policy.default_vote_policy;
  if (!isObj(vp) || vp.weight_kind !== "RoleWeight") return null;
  const t = vp.threshold;
  if (Array.isArray(t) && t.length === 2 && typeof t[0] === "number" && typeof t[1] === "number" && t[1] > 0) return Math.floor((size * t[0]) / t[1]) + 1;
  if (typeof t === "string" && /^\d+$/.test(t)) return Number(t);
  return null;
}

const every = (s: YieldSettings) => `every ${s.checkEvery === "15m" ? "15 minutes" : CHECK_EVERY_LONG[s.checkEvery]}`;

/** The one sentence on Review (K7): the exact limits the user typed. */
export function reviewSentence(s: Pick<YieldSettings, "maxPut" | "keepReady" | "minApr" | "checkEvery">, decimals: number, symbol: string): string {
  const full = { ...s, mode: "suggest", paused: false } as YieldSettings;
  return `Checks Rhea Lend ${every(full)} and suggests putting up to ${readAmount(s.maxPut, decimals)} ${symbol} to work, always keeping ${readAmount(s.keepReady, decimals)} ${symbol} ready, only above ${pctText(s.minApr)}% a year. You approve every move.`;
}

/** The one sentence under the K8 title. */
export function summarySentence(s: YieldSettings | null, decimals: number, symbol: string): string {
  if (s === null) return "No limits are set, so suggestions use everything idle. You approve every move.";
  const base = reviewSentence(s, decimals, symbol);
  return s.paused ? `Paused. It will not suggest anything until you resume. ${base}` : base;
}
