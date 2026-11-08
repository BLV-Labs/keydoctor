// Yield agent proposals (yield plan YD4): pure builders for the DAO `add_proposal` calls the council votes on.
// Every receiver, method and token comes from the allowlist below, never from chain text or the AI step. The args
// are the ones scripts/yield-setup/spike.sh (YD0) uses. Testnet only: the mainnet builder waits for YD4b.
import type { Network } from "key-doctor";
import { base64Json, type AddProposalArgs } from "./guard-proposals.ts";

/** Where YD0 sends funds on each network; null means the builder is off there. */
export interface YieldAllowlist {
  lend: string;
  tokens: ReadonlyArray<{ token_id: string; symbol: string; decimals: number }>;
}

export const YIELD_ALLOWLIST: Record<Network, YieldAllowlist | null> = {
  testnet: {
    lend: "contract.1638481328.burrow.testnet",
    tokens: [{ token_id: "usdc.fakes.testnet", symbol: "USDC (test)", decimals: 6 }],
  },
  // YD4b: opens only after a tiny supply and withdraw on a real DAO (plan Y13).
  mainnet: null,
};

/** Every yield proposal description starts with this, so the page can find its own proposals. */
export const YIELD_PREFIX = "[KD-YIELD]";
/** Rhea Lend storage_balance_bounds.min on testnet, checked 2026-11-08 (0.1 NEAR). */
export const RHEA_STORAGE_YOCTO = "100000000000000000000000";
const REGISTER_GAS = "30000000000000";
/** ft_transfer_call runs Rhea's ft_on_transfer; execute(Withdraw) sends the token back. Both fit in 150 Tgas. */
const MOVE_GAS = "150000000000000";
const ONE_YOCTO = "1";

export type YieldProposalProblem = "NETWORK_OFF" | "OFF_ALLOWLIST" | "BAD_AMOUNT" | "OVER_AVAILABLE";

export class YieldProposalError extends Error {
  readonly code: YieldProposalProblem;
  constructor(code: YieldProposalProblem, message: string) {
    super(message);
    this.code = code;
    this.name = "YieldProposalError";
  }
}

function allowlist(network: Network): YieldAllowlist {
  const list = YIELD_ALLOWLIST[network];
  if (list === null) throw new YieldProposalError("NETWORK_OFF", `Yield proposals are not open on ${network} yet.`);
  return list;
}

/**
 * The only calls a yield proposal may make: storage_deposit and execute on the Rhea Lend contract, and
 * ft_transfer_call on an allowlisted token with Rhea Lend as its receiver. Anything else throws.
 */
export function checkYieldCall(network: Network, receiver: string, method: string, args: Record<string, unknown>): void {
  const list = allowlist(network);
  const onLend = receiver === list.lend && (method === "storage_deposit" || method === "execute");
  const onToken = list.tokens.some((t) => t.token_id === receiver) && method === "ft_transfer_call" && args.receiver_id === list.lend;
  if (!onLend && !onToken) throw new YieldProposalError("OFF_ALLOWLIST", `${method} on ${receiver} is not an allowed yield call.`);
}

function yieldCall(network: Network, description: string, receiver: string, method: string, args: Record<string, unknown>, deposit: string, gas: string): AddProposalArgs {
  checkYieldCall(network, receiver, method, args);
  return {
    proposal: {
      description: `${YIELD_PREFIX} ${description}`,
      kind: { FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: base64Json(args), deposit, gas }] } },
    },
  };
}

function token(network: Network, tokenId: string) {
  const t = allowlist(network).tokens.find((x) => x.token_id === tokenId);
  if (t === undefined) throw new YieldProposalError("OFF_ALLOWLIST", `${tokenId} is not an allowed yield token.`);
  return t;
}

/** One time: the DAO pays Rhea Lend's storage deposit for itself (no account_id = the DAO, the caller). */
export function registerProposal(network: Network): AddProposalArgs {
  return yieldCall(network, "register the DAO on Rhea Lend", allowlist(network).lend, "storage_deposit", {}, RHEA_STORAGE_YOCTO, REGISTER_GAS);
}

/** Supply `amount` raw units of an allowlisted token. `msg: ""` supplies without collateral, so Withdraw needs no oracle. */
export function supplyProposal(network: Network, tokenId: string, amount: string, available: string): AddProposalArgs {
  const t = token(network, tokenId);
  if (!/^[1-9]\d*$/.test(amount)) throw new YieldProposalError("BAD_AMOUNT", "Enter an amount above 0.");
  if (!/^\d+$/.test(available) || BigInt(amount) > BigInt(available)) {
    throw new YieldProposalError("OVER_AVAILABLE", `The amount is more than the ${tokenAmount(available, t.decimals)} ${t.symbol} available.`);
  }
  const lend = allowlist(network).lend;
  return yieldCall(network, `supply ${tokenAmount(amount, t.decimals)} ${t.symbol} to Rhea Lend`, t.token_id, "ft_transfer_call", { receiver_id: lend, amount, msg: "" }, ONE_YOCTO, MOVE_GAS);
}

/** Withdraw the whole supplied balance, interest included (no max_amount, as YD0 runs it). */
export function withdrawAllProposal(network: Network, tokenId: string): AddProposalArgs {
  const t = token(network, tokenId);
  return yieldCall(network, `withdraw all ${t.symbol} from Rhea Lend`, allowlist(network).lend, "execute", { actions: [{ Withdraw: { token_id: t.token_id } }] }, ONE_YOCTO, MOVE_GAS);
}

/** Raw token units to a decimal string without float rounding: ("12500000", 6) → "12.5". */
export function tokenAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return "unknown";
  const unit = 10n ** BigInt(decimals);
  const v = BigInt(raw);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / unit}.${frac}` : `${v / unit}`;
}

/** A typed token amount to raw units: ("12.5", 6) → "12500000". Null if not a plain decimal with at most `decimals` places. */
export function tokenRaw(text: string, decimals: number): string | null {
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`).exec(text.trim());
  if (!m) return null;
  return (BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0")).toString();
}
