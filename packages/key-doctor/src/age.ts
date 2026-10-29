import type { KeyInfo, Network } from "./types.ts";
import { BLOCK_TIME_MS, GENESIS_HEIGHT, MS_PER_DAY, NONCE_BLOCK_DIVISOR } from "./rules/thresholds.ts";

export interface HeadBlock {
  height: number;
  timestampMs: number;
}

export interface KeyAge {
  created: KeyInfo["created"];
  age_days: number | null;
  use_count: number | null;
}

/** ISO 8601 UTC, whole seconds, e.g. 2026-07-24T03:17:56Z. */
export function toIsoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function estimateAge(nonce: string, network: Network, head: HeadBlock): KeyAge {
  const n = BigInt(nonce);
  const divisor = BigInt(NONCE_BLOCK_DIVISOR);
  const height = Number(n / divisor);
  const uses = Number(n % divisor);
  if (height < GENESIS_HEIGHT[network] || height > head.height) {
    return {
      created: { block_height: null, at: null, source: "unknown" },
      age_days: null,
      use_count: height === 0 ? uses : null,
    };
  }
  const elapsedMs = (head.height - height) * BLOCK_TIME_MS;
  return {
    created: { block_height: height, at: toIsoSeconds(head.timestampMs - elapsedMs), source: "nonce_estimate" },
    age_days: Math.floor(elapsedMs / MS_PER_DAY),
    use_count: uses,
  };
}
