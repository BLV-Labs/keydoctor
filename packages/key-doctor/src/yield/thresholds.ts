import type { Network } from "../types.ts";

// Yield agent limits and allowlists (yield plan Y7, Y8, Y9, Y20).
// Changing any value in this file means bumping YIELD_RULESET_VERSION. It is separate from RULESET_VERSION,
// so a yield change does not reset the security diff of every subscribed DAO.
export const YIELD_RULESET_VERSION = "2026-11-08";

/** Rhea Lend (Burrow) per network. Mainnet is read for rates only until YD4b. */
export const RHEA_LEND_CONTRACT: Record<Network, string> = {
  mainnet: "contract.main.burrow.near",
  testnet: "contract.1638481328.burrow.testnet",
};

export interface YieldToken {
  token_id: string;
  /** Shown to users. Chain and API symbols are never used: they are untrusted text. */
  symbol: string;
  decimals: number;
}

/**
 * Y7: one stablecoin at a time. Mainnet holds native USDC and USDt only; bridged USDC.e, USDT.e and DAI add
 * bridge risk. Testnet holds the token YD0 proved (open mint, so any test DAO can get some).
 */
export const YIELD_TOKENS: Record<Network, readonly YieldToken[]> = {
  mainnet: [
    { token_id: "usdt.tether-token.near", symbol: "USDt", decimals: 6 },
    { token_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", decimals: 6 },
  ],
  testnet: [{ token_id: "usdc.fakes.testnet", symbol: "USDC (test)", decimals: 6 }],
};

/**
 * Second source on mainnet: APR (in percent), price and liquidity, about 9 KB for 18 rows (checked 2026-11-08).
 * The on-chain Pyth prices for USDC and USDt were months old that day, so the price comes from here.
 */
export const RHEA_API_URL = "https://api.burrow.finance/list_token_data";
/** The API writes APR in percent. */
export const RHEA_API_PERCENT = 100;

/**
 * Y8 floors, mainnet only. Checked against live data on 2026-11-08: USDt TVL $12.6M, liquidity $1.98M,
 * price 0.9986, APR 7.28% on both sources; native USDC TVL $12.8M, liquidity $1.86M, price 0.9998, APR 8.96%.
 */
export const YIELD_LIMITS = {
  min_tvl_usd: 1_000_000,
  min_liquidity_usd: 250_000,
  /** |price - 1| for a stablecoin. */
  max_price_gap: 0.01,
  /** |APR on chain - APR from the API|, as a fraction (0.01 = 1 percentage point). */
  max_source_gap: 0.01,
  /** Above this APR the row stays but carries APR_HIGH. */
  warn_apr: 0.3,
} as const;

/** Rows read per get_assets_paged_detailed call (mainnet had 26 assets on 2026-11-08). */
export const RHEA_ASSETS_PAGE = 100;

/** Y9: newest proposals read for open Transfers. Sputnik proposals expire after a week by default. */
export const YIELD_PROPOSAL_SCAN = 40;

/** Y20: a push goes out when the top candidate changes or its APR moves at least this much (0.5 percentage point). */
export const YIELD_PUSH_APR_DELTA = 0.005;

/**
 * YD2 model step (plan §2). These limits shape the AI-assisted order only, never the report, so they do not move
 * YIELD_RULESET_VERSION.
 */
export const YIELD_ADVICE = {
  /** Cached advice is reused for at most a day (plan YD2), and only while its basis still matches the report. */
  max_age_ms: 24 * 60 * 60 * 1000,
  /** Per model call. Two calls on the chain plus the scans must fit the 30 s a webhook gets after its 200. */
  timeout_ms: 9000,
  /** A longer reason is dropped. */
  max_reason_chars: 400,
  max_tokens: 1200,
  /** A reason may write an evidence value as is, or in thousands, millions or billions (25k, $12.8M). */
  scales: [1, 1_000, 1_000_000, 1_000_000_000],
  /** More decimals than this is not a number a person would write: the reason is dropped. */
  max_decimals: 8,
} as const;
