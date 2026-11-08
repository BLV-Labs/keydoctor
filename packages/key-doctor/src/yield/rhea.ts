import type { Network, YieldOpportunity, YieldRejected, YieldRejectReason, YieldSource, YieldWarning } from "../types.ts";
import { toIsoSeconds } from "../age.ts";
import { fail, isKdError } from "../errors.ts";
import { accountKind, isDigits, isRecord } from "../parse.ts";
import { createRpc, DEFAULT_RPC_URLS, getJson } from "../rpc.ts";
import {
  RHEA_API_PERCENT,
  RHEA_API_URL,
  RHEA_ASSETS_PAGE,
  RHEA_LEND_CONTRACT,
  YIELD_LIMITS,
  YIELD_TOKENS,
} from "./thresholds.ts";

/** One Rhea Lend supply row before the filter. Every row is kept, so the filter can say why it drops one. */
export interface RheaRow {
  network: Network;
  token_id: string;
  apr: number;
  apy_reward: number | null;
  tvl_usd: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  sources: YieldSource[];
  can_deposit: boolean;
  can_withdraw: boolean;
}

export interface RheaRead {
  rows: RheaRow[];
  /** Fixed text, e.g. "rhea-api: RPC_ERROR". Never a URL or a body. */
  errors: string[];
}

/** `callFunction` reports a contract failure as NOT_A_DAO; for a protocol contract that is a contract error. */
const codeOf = (e: unknown): string => {
  const code = isKdError(e) ? e.kd.code : "RPC_ERROR";
  return code === "NOT_A_DAO" ? "CONTRACT_ERROR" : code;
};

const rate = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const allowlisted = (network: Network, tokenId: string) => YIELD_TOKENS[network].find((t) => t.token_id === tokenId);

/** Raw units (token decimals + Rhea extra decimals) to whole tokens, as a float: good enough for USD floors. */
const whole = (raw: string, decimals: number): number => Number(raw) / Number(10n ** BigInt(decimals));

interface ApiRow {
  apr: number;
  apy_reward: number | null;
  price: number | null;
}

/** Only allowlisted ids are kept, matched exactly; the API's symbol and other text are never read. */
function parseApi(body: unknown, network: Network): Map<string, ApiRow> {
  const out = new Map<string, ApiRow>();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (data === null) throw fail("RPC_ERROR");
  for (const r of data) {
    if (!isRecord(r) || typeof r.token !== "string" || allowlisted(network, r.token) === undefined) continue;
    const apr = rate(r.supply_apy);
    if (apr === null) continue;
    const farm = rate(r.supply_farm_apy);
    const price = typeof r.price === "number" && Number.isFinite(r.price) && r.price > 0 ? r.price : null;
    out.set(r.token, { apr: apr / RHEA_API_PERCENT, apy_reward: farm === null ? null : farm / RHEA_API_PERCENT, price });
  }
  return out;
}

/**
 * Reads every Rhea Lend asset on `network`, pinned to `blockHeight` when given. On mainnet the Rhea API adds a
 * second APR, the price and the reward APY; on testnet both are left out (test data, no price).
 * A failed contract read throws; a failed API read only goes into `errors`, so the filter fails closed.
 */
export async function readRheaLend(
  network: Network,
  opts: { rpcUrl?: string | readonly string[]; blockHeight?: number; nowMs?: number } = {},
): Promise<RheaRead> {
  const rpc = createRpc({ url: opts.rpcUrl ?? DEFAULT_RPC_URLS[network] });
  const errors: string[] = [];
  const height = opts.blockHeight ?? (await rpc.block()).height;
  const raw = await rpc.callFunction(RHEA_LEND_CONTRACT[network], height, "get_assets_paged_detailed", {
    from_index: 0,
    limit: RHEA_ASSETS_PAGE,
  });
  if (!Array.isArray(raw)) throw fail("RPC_ERROR");

  let api = new Map<string, ApiRow>();
  if (network === "mainnet") {
    try {
      api = parseApi(await getJson(RHEA_API_URL), network);
    } catch (e) {
      errors.push(`rhea-api: ${codeOf(e)}`);
    }
  }
  const apiAt = toIsoSeconds(opts.nowMs ?? Date.now());

  const rows: RheaRow[] = [];
  for (const a of raw) {
    if (!isRecord(a) || typeof a.token_id !== "string" || !isRecord(a.config)) continue;
    const apr = rate(a.supply_apr);
    if (apr === null) continue;
    const at = isDigits(a.last_update_timestamp) ? toIsoSeconds(Number(BigInt(a.last_update_timestamp) / 1_000_000n)) : apiAt;
    const sources: YieldSource[] = [{ name: "rhea-lend", apr, at }];
    const fromApi = api.get(a.token_id);
    if (fromApi !== undefined) sources.push({ name: "rhea-api", apr: fromApi.apr, at: apiAt });

    const token = allowlisted(network, a.token_id);
    const extra = a.config.extra_decimals;
    const supplied = isRecord(a.supplied) ? a.supplied.balance : undefined;
    const borrowed = isRecord(a.borrowed) ? a.borrowed.balance : undefined;
    const price = network === "mainnet" ? (fromApi?.price ?? null) : null;
    let tvl: number | null = null;
    let liquidity: number | null = null;
    if (price !== null && token !== undefined && Number.isSafeInteger(extra) && isDigits(supplied) && isDigits(borrowed)) {
      const d = token.decimals + (extra as number);
      tvl = whole(supplied, d) * price;
      // Conservative: supplied minus borrowed, ignoring the protocol reserve.
      liquidity = Math.max(0, whole((BigInt(supplied) - BigInt(borrowed)).toString(), d)) * price;
    }
    rows.push({
      network,
      token_id: a.token_id,
      apr,
      apy_reward: fromApi?.apy_reward ?? null,
      tvl_usd: tvl,
      liquidity_usd: liquidity,
      price_usd: price,
      sources,
      can_deposit: a.config.can_deposit === true,
      can_withdraw: a.config.can_withdraw === true,
    });
  }
  return { rows, errors };
}

const opportunityId = (tokenId: string) => `rhea-lend:${tokenId}:supply`;

/**
 * Pure. Applies the allowlist and the open flags everywhere, and the Y8 floors on mainnet only (testnet rates
 * and prices are test data). `daoNetwork` decides which rows a proposal can act on.
 * Opportunities come out highest APR first, then by id.
 */
export function filterCandidates(
  rows: readonly RheaRow[],
  daoNetwork: Network,
): { opportunities: YieldOpportunity[]; rejected: YieldRejected[] } {
  const opportunities: YieldOpportunity[] = [];
  const rejected: YieldRejected[] = [];
  const L = YIELD_LIMITS;
  for (const r of rows) {
    const token = allowlisted(r.network, r.token_id);
    // A token off the allowlist is never read further: its price and second source are not even fetched.
    const reasons: YieldRejectReason[] = token === undefined ? ["NOT_ALLOWLISTED"] : [];
    if (token !== undefined && !r.can_deposit) reasons.push("DEPOSIT_CLOSED");
    if (token !== undefined && !r.can_withdraw) reasons.push("WITHDRAW_CLOSED");
    if (token !== undefined && r.network === "mainnet") {
      if (r.price_usd === null) reasons.push("PRICE_UNKNOWN");
      else if (Math.abs(r.price_usd - 1) > L.max_price_gap) reasons.push("PRICE_GAP");
      if (r.tvl_usd !== null && r.tvl_usd < L.min_tvl_usd) reasons.push("TVL_LOW");
      if (r.liquidity_usd !== null && r.liquidity_usd < L.min_liquidity_usd) reasons.push("LIQUIDITY_LOW");
      if (r.sources.length < 2) reasons.push("SOURCE_MISSING");
      else {
        const aprs = r.sources.map((s) => s.apr);
        if (Math.max(...aprs) - Math.min(...aprs) > L.max_source_gap) reasons.push("SOURCE_GAP");
      }
    }
    if (reasons.length > 0 || token === undefined) {
      const safe = accountKind(r.token_id) === null ? "?" : r.token_id;
      rejected.push({ id: opportunityId(safe), network: r.network, token_id: safe, reasons });
      continue;
    }
    const warnings: YieldWarning[] = r.apr > L.warn_apr ? ["APR_HIGH"] : [];
    opportunities.push({
      id: opportunityId(r.token_id),
      protocol: "rhea-lend",
      network: r.network,
      token_id: r.token_id,
      symbol: token.symbol,
      apr: r.apr,
      apy_reward: r.apy_reward,
      tvl_usd: r.tvl_usd,
      liquidity_usd: r.liquidity_usd,
      price_usd: r.price_usd,
      sources: r.sources,
      executable: r.network === daoNetwork,
      test_data: r.network === "testnet",
      warnings,
    });
  }
  opportunities.sort((a, b) => b.apr - a.apr || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { opportunities, rejected };
}
