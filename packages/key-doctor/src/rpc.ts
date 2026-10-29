import type { Network } from "./types.ts";
import type { HeadBlock } from "./age.ts";
import { fail } from "./errors.ts";
import { parseRawKey, type RawKey } from "./parse.ts";
import { RPC_TIMEOUT_MS } from "./rules/thresholds.ts";

export const DEFAULT_RPC_URL: Record<Network, string> = {
  mainnet: "https://rpc.mainnet.near.org",
  testnet: "https://rpc.testnet.near.org",
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Rpc {
  /** `height` undefined = latest final block. */
  block(height?: number): Promise<HeadBlock>;
  viewAccessKeyList(accountId: string, blockId: number): Promise<RawKey[]>;
  /** Resolves when the account exists; a missing account throws NOT_FOUND. */
  viewAccount(accountId: string, blockId: number): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Error text is fixed per code: never the URL, the body, `error.data` or `error.message`. */
function unwrap(body: unknown, blockPinnedByCaller: boolean): Record<string, unknown> {
  if (!isRecord(body)) throw fail("RPC_ERROR");
  if ("error" in body && body.error !== undefined && body.error !== null) {
    const cause = isRecord(body.error) ? body.error.cause : undefined;
    const name = isRecord(cause) && typeof cause.name === "string" ? cause.name : "";
    if (name === "UNKNOWN_ACCOUNT") throw fail("NOT_FOUND");
    if (name === "UNKNOWN_BLOCK") throw fail("RPC_ERROR", { retryable: !blockPinnedByCaller });
    throw fail("RPC_ERROR", { retryable: false });
  }
  const result = body.result;
  if (!isRecord(result)) throw fail("RPC_ERROR");
  if (typeof result.error === "string") throw fail("RPC_ERROR", { retryable: false });
  return result;
}

export function createRpc(cfg: { url: string; fetchImpl?: FetchLike }): Rpc {
  const doFetch: FetchLike = cfg.fetchImpl ?? ((...a) => globalThis.fetch(...a));

  async function call(
    method: string,
    params: Record<string, unknown>,
    blockPinnedByCaller = false,
  ): Promise<Record<string, unknown>> {
    const ctl = new AbortController();
    // Stays armed until the body is parsed, so a stalled body read also times out.
    const timer = setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await doFetch(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "kd", method, params }),
          signal: ctl.signal,
        });
      } catch {
        throw fail("RPC_ERROR");
      }
      if (res.status === 429) throw fail("RATE_LIMITED");
      if (res.status >= 500) throw fail("RPC_ERROR");
      if (res.status < 200 || res.status >= 300) throw fail("RPC_ERROR", { retryable: false });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw fail("RPC_ERROR");
      }
      return unwrap(body, blockPinnedByCaller);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async block(height) {
      const params = height === undefined ? { finality: "final" } : { block_id: height };
      const result = await call("block", params, height !== undefined);
      const header = result.header;
      if (!isRecord(header)) throw fail("RPC_ERROR");
      const ns = header.timestamp_nanosec;
      if (!Number.isSafeInteger(header.height) || (header.height as number) < 1) throw fail("RPC_ERROR");
      if (typeof ns !== "string" || !/^\d+$/.test(ns)) throw fail("RPC_ERROR");
      return { height: header.height as number, timestampMs: Number(BigInt(ns) / 1_000_000n) };
    },

    async viewAccessKeyList(accountId, blockId) {
      const result = await call("query", { request_type: "view_access_key_list", block_id: blockId, account_id: accountId });
      if (!Array.isArray(result.keys)) throw fail("RPC_ERROR");
      const keys: RawKey[] = [];
      for (const raw of result.keys) {
        const key = parseRawKey(raw);
        if (key === null) throw fail("RPC_ERROR");
        keys.push(key);
      }
      return keys;
    },

    async viewAccount(accountId, blockId) {
      const result = await call("query", { request_type: "view_account", block_id: blockId, account_id: accountId });
      if (typeof result.amount !== "string") throw fail("RPC_ERROR");
    },
  };
}
