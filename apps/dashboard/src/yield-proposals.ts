// Yield agent proposals (yield plan YD4): pure builders for the DAO `add_proposal` calls the council votes on.
// Every receiver, method and token comes from the allowlist below, never from chain text or the AI step. The args
// are the ones scripts/yield-setup/spike.sh (YD0) uses. Testnet only: the mainnet builder waits for YD4b.
import type { Network } from "key-doctor";
import { base64Json, type AddProposalArgs } from "./guard-proposals.ts";

/** Where YD0 sends funds on each network; null means the builder is off there. */
export interface YieldAllowlist {
  lend: string;
  /** extra_decimals: Rhea Lend keeps balances with this many more decimals than the token (checked on the chain). */
  tokens: ReadonlyArray<{ token_id: string; symbol: string; decimals: number; extra_decimals: number }>;
}

export const YIELD_ALLOWLIST: Record<Network, YieldAllowlist | null> = {
  testnet: {
    lend: "contract.1638481328.burrow.testnet",
    tokens: [{ token_id: "usdc.fakes.testnet", symbol: "USDC (test)", decimals: 6, extra_decimals: 12 }],
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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);

function decodeArgs(b64: unknown): unknown {
  if (typeof b64 !== "string") return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return undefined;
  }
}

/**
 * True only when a proposal kind is one of the three calls this page builds, read back from the chain: one
 * FunctionCall action, the allowlisted receiver and method, the exact args shape and deposit. The description is
 * never trusted: anyone can add a proposal that says "[KD-YIELD] supply" but pays someone else.
 */
export function allowedYieldKind(network: Network, kind: Record<string, unknown>): boolean {
  const list = YIELD_ALLOWLIST[network];
  const fc = kind.FunctionCall;
  if (list === null || !isObj(fc) || !sameKeys(fc, ["receiver_id", "actions"]) || !Array.isArray(fc.actions) || fc.actions.length !== 1) return false;
  const a: unknown = fc.actions[0];
  if (!isObj(a) || typeof a.method_name !== "string") return false;
  const args = decodeArgs(a.args);
  if (!isObj(args)) return false;
  const receiver = fc.receiver_id;
  const isToken = (id: unknown) => list.tokens.some((t) => t.token_id === id);
  if (receiver === list.lend && a.method_name === "storage_deposit") return a.deposit === RHEA_STORAGE_YOCTO && Object.keys(args).length === 0;
  if (a.deposit !== ONE_YOCTO) return false;
  if (isToken(receiver) && a.method_name === "ft_transfer_call") {
    return sameKeys(args, ["receiver_id", "amount", "msg"]) && args.receiver_id === list.lend && typeof args.amount === "string" && /^[1-9]\d*$/.test(args.amount) && args.msg === "";
  }
  if (receiver === list.lend && a.method_name === "execute") {
    if (!sameKeys(args, ["actions"]) || !Array.isArray(args.actions) || args.actions.length !== 1) return false;
    const w: unknown = args.actions[0];
    if (!isObj(w) || !sameKeys(w, ["Withdraw"]) || !isObj(w.Withdraw)) return false;
    const t = list.tokens.find((x) => x.token_id === (w.Withdraw as Record<string, unknown>).token_id);
    if (t === undefined) return false;
    if (sameKeys(w.Withdraw, ["token_id"])) return true;
    // A part: a whole number of token units in Rhea's inner precision, so the page can say exactly how much.
    const amount = w.Withdraw.amount;
    return sameKeys(w.Withdraw, ["token_id", "amount"]) && typeof amount === "string" && /^[1-9]\d*$/.test(amount) && BigInt(amount) % 10n ** BigInt(t.extra_decimals) === 0n;
  }
  return false;
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

/** Withdraw the whole supplied balance, interest included (no amount, as YD0 runs it). */
export function withdrawAllProposal(network: Network, tokenId: string): AddProposalArgs {
  const t = token(network, tokenId);
  return yieldCall(network, `withdraw all ${t.symbol} from Rhea Lend`, allowlist(network).lend, "execute", { actions: [{ Withdraw: { token_id: t.token_id } }] }, ONE_YOCTO, MOVE_GAS);
}

/**
 * Withdraw `amount` raw token units of what the DAO has supplied (`supplied`, raw). Rhea Lend reads `amount` in its
 * inner precision, so the extra decimals are added. Null, or the whole supplied amount, withdraws all, so interest
 * still accruing comes back too instead of staying behind as dust.
 */
export function withdrawProposal(network: Network, tokenId: string, amount: string | null, supplied: string): AddProposalArgs {
  const t = token(network, tokenId);
  if (amount === null || amount === supplied) return withdrawAllProposal(network, tokenId);
  if (!/^[1-9]\d*$/.test(amount)) throw new YieldProposalError("BAD_AMOUNT", "Enter an amount above 0, or leave it empty to take all back.");
  if (!/^\d+$/.test(supplied) || BigInt(amount) > BigInt(supplied)) {
    throw new YieldProposalError("OVER_AVAILABLE", `The amount is more than the ${tokenAmount(supplied, t.decimals)} ${t.symbol} on Rhea Lend.`);
  }
  const inner = (BigInt(amount) * 10n ** BigInt(t.extra_decimals)).toString();
  return yieldCall(network, `withdraw ${tokenAmount(amount, t.decimals)} ${t.symbol} from Rhea Lend`, allowlist(network).lend, "execute", { actions: [{ Withdraw: { token_id: t.token_id, amount: inner } }] }, ONE_YOCTO, MOVE_GAS);
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

/** Amounts are raw token units; a withdraw amount of null takes everything back. */
export type YieldMove = { kind: "register" } | { kind: "supply"; amount: string } | { kind: "withdraw"; amount: string | null };

/**
 * What an allowed yield proposal does, read back from its kind for plain wording. Null for anything the page
 * does not build (same guard as allowedYieldKind), so a look-alike proposal is never described as a move.
 */
export function describeYieldKind(network: Network, kind: Record<string, unknown>): YieldMove | null {
  if (!allowedYieldKind(network, kind)) return null;
  const fc = kind.FunctionCall as { actions: Array<{ method_name: string; args: string }> };
  const a = fc.actions[0]!;
  if (a.method_name === "storage_deposit") return { kind: "register" };
  if (a.method_name === "execute") {
    const w = (decodeArgs(a.args) as { actions: Array<{ Withdraw: { token_id: string; amount?: string } }> }).actions[0]!.Withdraw;
    const t = YIELD_ALLOWLIST[network]!.tokens.find((x) => x.token_id === w.token_id)!;
    return { kind: "withdraw", amount: w.amount === undefined ? null : (BigInt(w.amount) / 10n ** BigInt(t.extra_decimals)).toString() };
  }
  const args = decodeArgs(a.args) as { amount: string };
  return { kind: "supply", amount: args.amount };
}
