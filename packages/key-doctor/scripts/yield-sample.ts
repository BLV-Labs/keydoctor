// Synthetic yield report for the Y5 compare and the TEE verify script: testnet token ids, realistic mainnet-like
// rates, fake holdings. No real account, so its output can be committed.
import type { KdYieldReport, YieldOpportunity } from "../src/index.ts";

const NOW = new Date().toISOString();
const opp = (token: string, symbol: string, apr: number, tvl: number, liquidity: number, price: number, warnings: YieldOpportunity["warnings"] = []): YieldOpportunity => ({
  id: `rhea-lend:${token}:supply`,
  protocol: "rhea-lend",
  network: "testnet",
  token_id: token,
  symbol,
  apr,
  apy_reward: null,
  tvl_usd: tvl,
  liquidity_usd: liquidity,
  price_usd: price,
  sources: [{ name: "rhea-lend", apr, at: NOW }],
  executable: true,
  test_data: true,
  warnings,
});

/** Three suggestions in rule order (highest APR first): a thin, high-APR pool, then two stablecoins. */
export const YIELD_SAMPLE_REPORT: KdYieldReport = {
  schema_version: "kd.yield.v1",
  yield_ruleset_version: "compare",
  generated_at: NOW,
  chain: { network: "testnet", block_height: 1, block_timestamp: NOW },
  dao: "kd-demo.sputnik-dao.testnet",
  holdings: [
    { token_id: "wrap.testnet", symbol: "wNEAR (test)", decimals: 24, balance: "400000000000000000000000000", open_transfers: [], available: "400000000000000000000000000", error: null },
    { token_id: "usdc.fakes.testnet", symbol: "USDC (test)", decimals: 6, balance: "30000000000", open_transfers: [{ proposal_id: 7, amount: "5000000000" }], available: "25000000000", error: null },
    { token_id: "usdt.fakes.testnet", symbol: "USDT (test)", decimals: 6, balance: "1250000000", open_transfers: [], available: "1250000000", error: null },
  ],
  opportunities: [
    opp("wrap.testnet", "wNEAR (test)", 0.1412, 410_000, 52_000, 2.71, ["APR_HIGH"]),
    opp("usdc.fakes.testnet", "USDC (test)", 0.0896, 12_800_000, 1_860_000, 0.9998),
    opp("usdt.fakes.testnet", "USDT (test)", 0.0728, 12_600_000, 1_980_000, 1.0001),
  ],
  rejected: [],
  suggestions: [
    { opportunity_id: "rhea-lend:wrap.testnet:supply", token_id: "wrap.testnet", max_amount: "400000000000000000000000000" },
    { opportunity_id: "rhea-lend:usdc.fakes.testnet:supply", token_id: "usdc.fakes.testnet", max_amount: "25000000000" },
    { opportunity_id: "rhea-lend:usdt.fakes.testnet:supply", token_id: "usdt.fakes.testnet", max_amount: "1250000000" },
  ],
  notes: [],
  errors: [],
  limitations: [],
};
