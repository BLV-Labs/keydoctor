import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const HEAD = 182340111;
export const HEAD_TS_SEC = 1793671210;
export const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");

export interface Req {
  url: string;
  method: string;
  params: Record<string, unknown>;
}
export type Reply = unknown;
export type Route = (req: Req) => Reply | Promise<Reply>;

export const fixture = <T = any>(rel: string): T => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;

export const ok = (result: unknown) => ({ jsonrpc: "2.0", id: "kd", result });
/** Error body whose free-text fields hold markers that must never reach the caller. */
export const rpcErr = (cause: string) => ({
  jsonrpc: "2.0",
  id: "kd",
  error: { code: -32000, message: "SECRET-MESSAGE", data: "SECRET-DATA", name: "HANDLER_ERROR", cause: { name: cause, info: {} } },
});
export const blockBody = (height = HEAD) =>
  ok({ author: "v.testnet", header: { height, hash: "h", timestamp_nanosec: `${HEAD_TS_SEC}000000000` }, chunks: [] });

/** Installs a stub `globalThis.fetch` (restored by the test context) and returns the recorded requests. */
export function installFetch(t: TestContext, route: Route): Req[] {
  const calls: Req[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const req: Req = { url: String(input), method: sent.method, params: sent.params };
    calls.push(req);
    const reply = await route.call(init, req);
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { status: 200 });
  });
  return calls;
}

export interface World {
  /** account id -> raw key list. A missing entry answers UNKNOWN_ACCOUNT. */
  keys?: Record<string, unknown[]>;
  /** accounts whose `view_account` answers UNKNOWN_ACCOUNT (or a custom reply). */
  missing?: string[];
  viewAccount?: Record<string, Reply>;
  block?: Reply;
}

export function world(w: World): Route {
  return (req) => {
    if (req.method === "block") return w.block ?? blockBody();
    const id = String(req.params.account_id);
    if (req.params.request_type === "view_access_key_list") {
      const keys = w.keys?.[id];
      return keys === undefined ? rpcErr("UNKNOWN_ACCOUNT") : ok({ block_height: HEAD, block_hash: "h", keys });
    }
    if (req.params.request_type === "view_account") {
      if (w.viewAccount && id in w.viewAccount) return w.viewAccount[id];
      if (w.missing?.includes(id)) return rpcErr("UNKNOWN_ACCOUNT");
      return ok({ amount: "1", locked: "0", code_hash: "1", storage_usage: 1 });
    }
    return rpcErr("UNKNOWN_METHOD");
  };
}

// Raw access-key builders.
export const FA = "FullAccess";
export const fc = (receiver: string, methods: string[] = ["m"], allowance: string | null = "1000") => ({
  FunctionCall: { allowance, receiver_id: receiver, method_names: methods },
});
export const rawKey = (pk: string, nonce: number | string, permission: unknown) => ({
  public_key: pk,
  access_key: { nonce, permission },
});
/** nonce = created block * 10^6 + use count */
export const nonceAt = (height: number, uses: number) => height * 1_000_000 + uses;
/** A recent, used key: no age or unused rule fires. */
export const RECENT = nonceAt(HEAD - 1000, 5);
export const ed = (i: number | string, nonce: number | string = RECENT, permission: unknown = FA) =>
  rawKey(`ed25519:E${i}`, nonce, permission);
export const ml = (i: number | string, nonce: number | string = RECENT, permission: unknown = FA) =>
  rawKey(`ml-dsa-65-hash:M${i}`, nonce, permission);
export const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
