// Rhea Lend (Burrow) interest model, pure: the supply APR after the treasury puts more in or takes some out, and the
// amount that earns the treasury the most. Same formula as the contract's get_rate and get_supply_apr, checked against
// get_asset on testnet (2026-11-10). It assumes borrowing stays as it is now: a projection, never a promise.
import { isDigits, isRecord } from "../parse.ts";

/** One Rhea Lend asset as `get_asset` returns it. Balances are in inner units (token decimals + extra_decimals). */
export interface RheaPool {
  token_id: string;
  extra_decimals: number;
  supplied: string;
  borrowed: string;
  reserved: string;
  /** Basis points of 10_000. */
  target_utilization: number;
  reserve_ratio: number;
  /** Per-millisecond borrow rate with 27 decimals, e.g. "1000000000002440418605283556". */
  target_utilization_rate: string;
  max_utilization_rate: string;
}

const MS_PER_YEAR = 31_536_000_000;
const RATE_ONE = 10n ** 27n;
const RATIO = 10_000;
/** Points tried before the search narrows in: enough to land in the right bend of the curve. */
const GRID = 256;
/** Golden-section step, (√5 − 1) / 2. */
const GOLDEN = 0.6180339887498949;

/** Null when any field the model needs is missing, so the page shows no projection rather than a wrong one. */
export function parseRheaPool(asset: unknown): RheaPool | null {
  if (!isRecord(asset) || typeof asset.token_id !== "string" || !isRecord(asset.config)) return null;
  const c = asset.config;
  const supplied = isRecord(asset.supplied) ? asset.supplied.balance : undefined;
  const borrowed = isRecord(asset.borrowed) ? asset.borrowed.balance : undefined;
  const bps = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= RATIO;
  const rate = (v: unknown): v is string => isDigits(v) && BigInt(v) >= RATE_ONE;
  if (!isDigits(supplied) || !isDigits(borrowed) || !isDigits(asset.reserved)) return null;
  if (!bps(c.target_utilization) || c.target_utilization === 0 || c.target_utilization === RATIO || !bps(c.reserve_ratio)) return null;
  if (!rate(c.target_utilization_rate) || !rate(c.max_utilization_rate)) return null;
  if (typeof c.extra_decimals !== "number" || !Number.isSafeInteger(c.extra_decimals) || c.extra_decimals < 0) return null;
  return {
    token_id: asset.token_id,
    extra_decimals: c.extra_decimals,
    supplied,
    borrowed,
    reserved: asset.reserved,
    target_utilization: c.target_utilization,
    reserve_ratio: c.reserve_ratio,
    target_utilization_rate: c.target_utilization_rate,
    max_utilization_rate: c.max_utilization_rate,
  };
}

/** The per-millisecond rate's part above 1, as a float: "1000000000002440418605283556" is 2.44e-12. */
const excess = (rate: string): number => Number(BigInt(rate) - RATE_ONE) / Number(RATE_ONE);

/**
 * Supply APR (a fraction) when the pool holds `supplied` inner units. Utilization is borrowed over supplied plus the
 * reserve; below the target the per-ms rate climbs gently, above it steeply to the max rate at 100%.
 */
function supplyApr(pool: RheaPool, supplied: number): number {
  const borrowed = Number(pool.borrowed);
  if (supplied <= 0 || borrowed <= 0) return 0;
  const total = supplied + Number(pool.reserved);
  const pos = Math.min(1, borrowed / total);
  const t = pool.target_utilization / RATIO;
  const tur = excess(pool.target_utilization_rate);
  const mur = excess(pool.max_utilization_rate);
  const perMs = pos < t ? (pos * tur) / t : tur + ((pos - t) * (mur - tur)) / (1 - t);
  const borrowApr = Math.expm1(MS_PER_YEAR * Math.log1p(perMs));
  return (borrowApr * borrowed * (1 - pool.reserve_ratio / RATIO)) / supplied;
}

const inner = (pool: RheaPool, raw: bigint): number => Number(raw * 10n ** BigInt(pool.extra_decimals));

/**
 * Supply APR (a fraction) after the treasury changes its supply by `change` token raw units: positive puts more in,
 * negative takes some out. A change of 0 gives today's rate.
 */
export function supplyAprAfter(pool: RheaPool, change: bigint): number {
  return supplyApr(pool, Number(pool.supplied) + inner(pool, change));
}

/** What the treasury's whole position would earn in a year at the rate after `change`, in token raw units. */
export function yearlyEarnings(pool: RheaPool, own: bigint, change: bigint): bigint {
  const position = own + change;
  if (position <= 0n) return 0n;
  return BigInt(Math.floor(Number(position) * supplyAprAfter(pool, change)));
}

/** Rounds down to two significant whole tokens (497,312.4 → 490,000): near the best amount the curve is flat. */
function roundDown(raw: bigint, decimals: number): bigint {
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  if (whole < 100n) return whole > 0n ? whole * unit : raw;
  let step = 1n;
  while (whole / step >= 100n) step *= 10n;
  return (whole / step) * step * unit;
}

/**
 * How much of `max` (token raw units) to put in so the treasury's whole position (`own` already supplied plus the
 * new amount) earns the most a year. Each deposit lowers the rate for everyone, the treasury included, so past a
 * point more money earns less. Returns `max` when putting it all in earns the most, 0 when any more would lower
 * what the treasury earns, else the best amount rounded down to two significant whole tokens.
 */
export function bestSupply(pool: RheaPool, own: bigint, max: bigint, decimals: number): bigint {
  if (max <= 0n) return 0n;
  const scale = Number(10n ** BigInt(pool.extra_decimals));
  const earn = (d: number) => (Number(own) + d) * supplyApr(pool, Number(pool.supplied) + d * scale);
  const top = Number(max);
  // Linear points cover the whole range; halving points find a best amount far below max.
  const points = new Set<number>([0, top]);
  for (let i = 1; i < GRID; i += 1) points.add((top * i) / GRID);
  for (let d = top / 2; d >= 1; d /= 2) points.add(d);
  const sorted = [...points].sort((a, b) => a - b);
  let at = 0;
  for (let i = 1; i < sorted.length; i += 1) if (earn(sorted[i]!) > earn(sorted[at]!)) at = i;
  if (at === sorted.length - 1 || earn(sorted[at]!) <= earn(top)) return max;
  if (at === 0) return 0n;
  // Golden-section search between the best point's neighbours.
  let lo = sorted[at - 1]!;
  let hi = sorted[at + 1]!;
  for (let i = 0; i < 80; i += 1) {
    const a = hi - GOLDEN * (hi - lo);
    const b = lo + GOLDEN * (hi - lo);
    if (earn(a) < earn(b)) lo = a;
    else hi = b;
  }
  const best = BigInt(Math.floor((lo + hi) / 2));
  return best >= max ? max : roundDown(best, decimals);
}
