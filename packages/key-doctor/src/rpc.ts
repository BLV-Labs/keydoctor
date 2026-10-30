import type { Network } from "./types.ts";
import type { HeadBlock } from "./age.ts";
import { fail, isKdError } from "./errors.ts";
import { isDigits, isRecord, parseRawKey, type RawKey } from "./parse.ts";
import { RATE_LIMIT_BACKOFF_MS, RPC_TIMEOUT_MS } from "./rules/thresholds.ts";

/**
 * Default endpoints, tried in order. FastNEAR answered about 12x faster than near.org on testnet
 * (docs/data-sources-benchmark.md); near.org stays as the fallback when FastNEAR rate-limits or fails.
 */
export const DEFAULT_RPC_URLS: Record<Network, readonly string[]> = {
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"],
  testnet: ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"],
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Rpc {
  /** `height` undefined = latest final block. */
  block(height?: number): Promise<HeadBlock>;
  viewAccessKeyList(accountId: string, blockId: number): Promise<RawKey[]>;
  /** Resolves when the account exists; a missing account throws NOT_FOUND. */
  viewAccount(accountId: string, blockId: number): Promise<void>;
  /**
   * Calls a view method and returns its JSON result. Contract-level failures
   * (no code, execution error, undecodable result) throw NOT_A_DAO: only get_policy uses this.
   */
  callFunction(accountId: string, blockId: number, methodName: string, args: unknown): Promise<unknown>;
}

/** Error text is fixed per code: never the URL, the body, `error.data` or `error.message`. */
function unwrap(body: unknown, blockPinnedByCaller: boolean, contractFailureIsNotADao: boolean): Record<string, unknown> {
  if (!isRecord(body)) throw fail("RPC_ERROR");
  if ("error" in body && body.error !== undefined && body.error !== null) {
    const cause = isRecord(body.error) ? body.error.cause : undefined;
    const name = isRecord(cause) && typeof cause.name === "string" ? cause.name : "";
    if (name === "UNKNOWN_ACCOUNT") throw fail("NOT_FOUND");
    if (name === "UNKNOWN_BLOCK") throw fail("RPC_ERROR", { retryable: !blockPinnedByCaller });
    if (contractFailureIsNotADao && (name === "NO_CONTRACT_CODE" || name === "CONTRACT_EXECUTION_ERROR")) {
      throw fail("NOT_A_DAO");
    }
    throw fail("RPC_ERROR", { retryable: false });
  }
  const result = body.result;
  if (!isRecord(result)) throw fail("RPC_ERROR");
  if (typeof result.error === "string") {
    throw contractFailureIsNotADao ? fail("NOT_A_DAO") : fail("RPC_ERROR", { retryable: false });
  }
  return result;
}

/** A failure of the endpoint itself (no answer, HTTP error, unreadable body): the next endpoint may do better. */
class TransportFailure {
  readonly error: Error;
  constructor(error: Error) {
    this.error = error;
  }
}

/**
 * `url` may list several endpoints. Each call tries them in order, starting from the one that answered last,
 * and moves on only after a transport failure (429, any other non-2xx, timeout, network error, unreadable
 * body). A JSON-RPC answer, even an error such as UNKNOWN_ACCOUNT, is final: another node would say the same.
 * Every query carries its block_id, so switching endpoints mid-scan does not change what the scan reads.
 * When every endpoint answered 429, the call waits RATE_LIMIT_BACKOFF_MS once and tries them all again.
 */
export function createRpc(cfg: { url: string | readonly string[]; fetchImpl?: FetchLike; rateLimitBackoffMs?: number }): Rpc {
  const doFetch: FetchLike = cfg.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const urls = typeof cfg.url === "string" ? [cfg.url] : [...cfg.url];
  if (urls.length === 0) throw fail("RPC_ERROR", { retryable: false });
  let preferred = 0;
  const rateLimitBackoffMs = cfg.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS;

  async function call(
    method: string,
    params: Record<string, unknown>,
    blockPinnedByCaller = false,
    contractFailureIsNotADao = false,
  ): Promise<Record<string, unknown>> {
    let last: Error | undefined;
    for (let round = 0; round < 2; round++) {
      let allRateLimited = true;
      for (let i = 0; i < urls.length; i++) {
        const idx = (preferred + i) % urls.length;
        try {
          const result = await attempt(urls[idx] as string, method, params, blockPinnedByCaller, contractFailureIsNotADao);
          preferred = idx;
          return result;
        } catch (e) {
          if (!(e instanceof TransportFailure)) throw e;
          last = e.error;
          if (!(isKdError(e.error) && e.error.kd.code === "RATE_LIMITED")) allRateLimited = false;
        }
      }
      if (!allRateLimited) break;
      if (round === 0) await new Promise((r) => setTimeout(r, rateLimitBackoffMs));
    }
    throw last as Error;
  }

  async function attempt(
    url: string,
    method: string,
    params: Record<string, unknown>,
    blockPinnedByCaller: boolean,
    contractFailureIsNotADao: boolean,
  ): Promise<Record<string, unknown>> {
    const ctl = new AbortController();
    // Stays armed until the body is parsed, so a stalled body read also times out.
    const timer = setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "kd", method, params }),
          signal: ctl.signal,
        });
      } catch {
        throw new TransportFailure(fail("RPC_ERROR"));
      }
      if (res.status === 429) throw new TransportFailure(fail("RATE_LIMITED"));
      if (res.status >= 500) throw new TransportFailure(fail("RPC_ERROR"));
      if (res.status < 200 || res.status >= 300) throw new TransportFailure(fail("RPC_ERROR", { retryable: false }));
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new TransportFailure(fail("RPC_ERROR"));
      }
      // A node that lags behind may not have the block yet; another endpoint may.
      if (isRecord(body) && isRecord(body.error) && isRecord(body.error.cause) && body.error.cause.name === "UNKNOWN_BLOCK") {
        throw new TransportFailure(fail("RPC_ERROR", { retryable: !blockPinnedByCaller }));
      }
      return unwrap(body, blockPinnedByCaller, contractFailureIsNotADao);
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
      if (!isDigits(ns)) throw fail("RPC_ERROR");
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

    async callFunction(accountId, blockId, methodName, args) {
      let binary = "";
      for (const byte of new TextEncoder().encode(JSON.stringify(args))) binary += String.fromCharCode(byte);
      const result = await call(
        "query",
        { request_type: "call_function", block_id: blockId, account_id: accountId, method_name: methodName, args_base64: btoa(binary) },
        false,
        true,
      );
      const bytes = result.result;
      if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
        throw fail("NOT_A_DAO");
      }
      try {
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[]))) as unknown;
      } catch {
        throw fail("NOT_A_DAO");
      }
    },
  };
}
