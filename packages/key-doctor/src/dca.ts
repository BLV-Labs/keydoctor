// GĐ31 DCA NEAR -> USDT on the testnet Rhea exchange (docs/stories/epics/guard/gd31-dca-plan.md). The Guard holds the
// same ids as a constant per network (contracts/guard/src/policy.rs `dex_for`); the keeper and the dashboard read them here.
import type { PlanAction } from "./types.ts";
export const DCA_TESTNET = {
  wrap: "wrap.testnet",
  exchange: "ref-finance-101.testnet",
  pool_id: 57,
  token_out: "usdt.fakes.testnet",
  token_out_decimals: 6,
} as const;

const YOCTO_PER_NEAR = 10n ** 24n;

/** Both DCA swap shapes: the 1.4.0 `swap` (no floor) and the 1.5.0 `swap_with_floor`. */
export function isSwapType(type: string): boolean {
  return type === "swap" || type === "swap_with_floor";
}

export function isSwapAction(action: PlanAction): action is Extract<PlanAction, { type: "swap" | "swap_with_floor" }> {
  return isSwapType(action.type);
}

/** "896500" with 6 decimals to "0.8965". Not a number: "?". */
export function formatUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return "?";
  const unit = 10n ** BigInt(decimals);
  const v = BigInt(raw);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / unit}.${frac}` : `${v / unit}`;
}

/** USDT per NEAR from one run, in bigint with the token's decimals; null when `amountIn` is 0 or either is not a number. */
export function dcaPrice(amountInYocto: string, amountOut: string): string | null {
  if (!/^\d+$/.test(amountInYocto) || !/^\d+$/.test(amountOut) || BigInt(amountInYocto) === 0n) return null;
  return formatUnits(((BigInt(amountOut) * YOCTO_PER_NEAR) / BigInt(amountInYocto)).toString(), DCA_TESTNET.token_out_decimals);
}
