import type { KdYieldReport, Network, ScanOptions, YieldHolding, YieldSuggestion } from "../types.ts";
import { toIsoSeconds } from "../age.ts";
import { fail, isKdError } from "../errors.ts";
import { isDigits, isRecord, parsePolicy, resolveTarget } from "../parse.ts";
import { createRpc, DEFAULT_RPC_URLS, type Rpc } from "../rpc.ts";
import { NO_SUGGESTION_NOTE, NOT_ADVICE_NOTE, PAYROLL_NOTE, REFERENCE_NOTE, TEST_DATA_NOTE } from "./messages.ts";
import { filterCandidates, readRheaLend, type RheaRow } from "./rhea.ts";
import { YIELD_PROPOSAL_SCAN, YIELD_PUSH_APR_DELTA, YIELD_RULESET_VERSION, YIELD_TOKENS } from "./thresholds.ts";

export interface ScanVaultOptions extends Pick<ScanOptions, "network" | "rpcUrl" | "blockHeight"> {
  /** Mainnet endpoints for the reference rates. Default: DEFAULT_RPC_URLS.mainnet. */
  mainnetRpcUrl?: string | readonly string[];
  /** For a testnet DAO, also read mainnet rates as reference (never executable). Default true. */
  referenceMainnet?: boolean;
}

export interface OpenTransfer {
  proposal_id: number;
  token_id: string;
  amount: string;
}

const codeOf = (e: unknown): string => {
  const code = isKdError(e) ? e.kd.code : "RPC_ERROR";
  return code === "NOT_A_DAO" ? "CONTRACT_ERROR" : code;
};

/** Y9: balance minus every open Transfer in the same token, never below 0. Raw token units. */
export function availableAmount(balance: string, openTransfers: readonly { amount: string }[]): string {
  const left = openTransfers.reduce((acc, t) => acc - BigInt(t.amount), BigInt(balance));
  return left > 0n ? left.toString() : "0";
}

/**
 * True when the top candidate changed, or its APR moved at least YIELD_PUSH_APR_DELTA since the last push.
 * `null` means no candidate: going to or from none is a change.
 */
export function shouldPushYield(prev: { id: string; apr: number } | null, next: { id: string; apr: number } | null): boolean {
  if (prev === null || next === null) return prev !== next;
  return prev.id !== next.id || Math.abs(next.apr - prev.apr) >= YIELD_PUSH_APR_DELTA;
}

function parseLastId(raw: unknown): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  throw fail("RPC_ERROR", { retryable: false });
}

/** NEP-141 methods that move the DAO's tokens out when a FunctionCall proposal on the token executes. */
const FT_OUT_METHODS = new Set(["ft_transfer", "ft_transfer_call"]);

function decodeArgs(b64: unknown): unknown {
  if (typeof b64 !== "string") throw fail("RPC_ERROR");
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as unknown;
  } catch {
    throw fail("RPC_ERROR");
  }
}

/** Amounts a FunctionCall proposal on a yield token would send out (a pending supply is one). */
function functionCallOut(fc: unknown): string[] {
  if (!isRecord(fc) || !Array.isArray(fc.actions)) throw fail("RPC_ERROR");
  const out: string[] = [];
  for (const a of fc.actions) {
    if (!isRecord(a) || typeof a.method_name !== "string") throw fail("RPC_ERROR");
    if (!FT_OUT_METHODS.has(a.method_name)) continue;
    const args = decodeArgs(a.args);
    if (!isRecord(args) || !isDigits(args.amount)) throw fail("RPC_ERROR");
    out.push(args.amount);
  }
  return out;
}

/**
 * Money already promised by open (InProgress) proposals among the newest YIELD_PROPOSAL_SCAN: token Transfers,
 * and ft_transfer / ft_transfer_call FunctionCalls on a yield token (such as a supply still being voted on).
 * Any such proposal we cannot read throws, so the caller fails closed instead of over-counting what is free.
 */
async function readOpenTransfers(
  rpc: Rpc,
  dao: string,
  height: number,
  tokenIds: ReadonlySet<string>,
): Promise<{ transfers: OpenTransfer[]; partial: boolean }> {
  const last = parseLastId(await rpc.callFunction(dao, height, "get_last_proposal_id", {}));
  const from = Math.max(0, last - YIELD_PROPOSAL_SCAN);
  if (last === 0) return { transfers: [], partial: false };
  const raw = await rpc.callFunction(dao, height, "get_proposals", { from_index: from, limit: YIELD_PROPOSAL_SCAN });
  if (!Array.isArray(raw)) throw fail("RPC_ERROR");
  const transfers: OpenTransfer[] = [];
  for (const p of raw) {
    if (!isRecord(p) || !isRecord(p.kind) || p.status !== "InProgress") continue;
    if ("FunctionCall" in p.kind) {
      const fc = p.kind.FunctionCall;
      if (!isRecord(fc) || typeof fc.receiver_id !== "string" || !Number.isSafeInteger(p.id)) throw fail("RPC_ERROR");
      if (!tokenIds.has(fc.receiver_id)) continue;
      for (const amount of functionCallOut(fc)) transfers.push({ proposal_id: p.id as number, token_id: fc.receiver_id, amount });
      continue;
    }
    if (!("Transfer" in p.kind)) continue;
    const t = p.kind.Transfer;
    if (!isRecord(t) || typeof t.token_id !== "string" || !isDigits(t.amount) || !Number.isSafeInteger(p.id)) {
      throw fail("RPC_ERROR");
    }
    if (t.token_id === "") continue; // NEAR, not a yield token.
    transfers.push({ proposal_id: p.id as number, token_id: t.token_id, amount: t.amount });
  }
  return { transfers, partial: from > 0 };
}

/**
 * Yield report for one Sputnik DAO (kd.yield.v1): what it holds of each allowlisted token, what is free after
 * open Transfers, and which Rhea Lend supplies a council could vote on. Reads only; never signs.
 * Throws when the block or `get_policy` cannot be read or the account is not a DAO. Every other failure goes
 * into `errors` and drops the suggestions it would affect (fail closed).
 */
export async function scanVault(daoId: string, opts: ScanVaultOptions = {}): Promise<KdYieldReport> {
  const target = resolveTarget(daoId, opts);
  const network = target.network;
  const rpc = createRpc({ url: opts.rpcUrl ?? DEFAULT_RPC_URLS[network] });
  const head = await rpc.block(opts.blockHeight);
  if (parsePolicy(await rpc.callFunction(target.id, head.height, "get_policy", {})) === null) throw fail("NOT_A_DAO");

  const errors: string[] = [];
  const limitations: string[] = [];

  let transfers: OpenTransfer[] | null = null;
  try {
    const read = await readOpenTransfers(rpc, target.id, head.height, new Set(YIELD_TOKENS[network].map((t) => t.token_id)));
    transfers = read.transfers;
    if (read.partial) {
      limitations.push(`Only the newest ${YIELD_PROPOSAL_SCAN} proposals were read for open transfers; an older open one is not counted.`);
    }
  } catch (e) {
    errors.push(`proposals: ${codeOf(e)}`);
  }

  const holdings: YieldHolding[] = [];
  for (const token of YIELD_TOKENS[network]) {
    const open = (transfers ?? []).filter((t) => t.token_id === token.token_id).map((t) => ({ proposal_id: t.proposal_id, amount: t.amount }));
    let balance: string | null = null;
    let error: string | null = null;
    try {
      const raw = await rpc.callFunction(token.token_id, head.height, "ft_balance_of", { account_id: target.id });
      if (!isDigits(raw)) throw fail("RPC_ERROR");
      balance = raw;
    } catch (e) {
      error = codeOf(e);
    }
    holdings.push({
      token_id: token.token_id,
      symbol: token.symbol,
      decimals: token.decimals,
      balance,
      open_transfers: open,
      available: balance !== null && transfers !== null ? availableAmount(balance, open) : null,
      error,
    });
  }

  const rows: RheaRow[] = [];
  const readRates = async (net: Network, rpcUrl: string | readonly string[] | undefined, blockHeight?: number) => {
    try {
      const r = await readRheaLend(net, { ...(rpcUrl !== undefined && { rpcUrl }), ...(blockHeight !== undefined && { blockHeight }) });
      rows.push(...r.rows);
      errors.push(...r.errors);
    } catch (e) {
      errors.push(`rhea-lend:${net}: ${codeOf(e)}`);
    }
  };
  await readRates(network, opts.rpcUrl, head.height);
  const reference = network === "testnet" && opts.referenceMainnet !== false;
  if (reference) await readRates("mainnet", opts.mainnetRpcUrl);

  const { opportunities, rejected } = filterCandidates(rows, network);

  const suggestions: YieldSuggestion[] = [];
  for (const o of opportunities) {
    if (!o.executable) continue;
    const h = holdings.find((x) => x.token_id === o.token_id);
    if (h?.available == null || BigInt(h.available) === 0n) continue;
    suggestions.push({ opportunity_id: o.id, token_id: o.token_id, max_amount: h.available });
  }

  const notes = [PAYROLL_NOTE, NOT_ADVICE_NOTE];
  if (opportunities.some((o) => o.test_data)) notes.push(TEST_DATA_NOTE);
  if (reference) notes.push(REFERENCE_NOTE);
  const holdsFree = holdings.some((h) => h.available !== null && BigInt(h.available) > 0n);
  if (suggestions.length === 0 && !holdsFree && holdings.every((h) => h.error === null) && transfers !== null) {
    notes.push(NO_SUGGESTION_NOTE);
  }

  return {
    schema_version: "kd.yield.v1",
    yield_ruleset_version: YIELD_RULESET_VERSION,
    generated_at: toIsoSeconds(Date.now()),
    chain: { network, block_height: head.height, block_timestamp: toIsoSeconds(head.timestampMs) },
    dao: target.id,
    holdings,
    opportunities,
    rejected,
    suggestions,
    notes,
    errors,
    limitations,
  };
}
