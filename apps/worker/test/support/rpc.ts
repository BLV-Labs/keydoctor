// Stub NEAR RPC answering from the key-doctor fixtures (DAO kd-demo.sputnik-dao.testnet at block 182340111).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";

const require = createRequire(import.meta.url);
export const fixture = <T = any>(rel: string): T =>
  JSON.parse(readFileSync(require.resolve(`key-doctor/fixtures/${rel}`), "utf8")) as T;

export const DAO = "kd-demo.sputnik-dao.testnet";
export const HEAD = 182340111;
const ok = (result: unknown) => ({ jsonrpc: "2.0", id: "kd", result });
const unknownAccount = { jsonrpc: "2.0", id: "kd", error: { code: -32000, message: "x", name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} } } };
export const bytes = (v: unknown) => ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))), logs: [], block_height: HEAD, block_hash: "h" });

export interface Chain {
  keys: Record<string, any>;
  calls: Record<string, unknown>[];
  /** Extra answers for call_function, by method name. */
  views: Record<string, (args: any) => unknown>;
  /** Telegram Bot API calls: method name and JSON body. */
  telegram: { method: string; body: any }[];
  /** Status the stub Telegram API answers with (200 by default). */
  telegramStatus: number;
  /** Head block the stub reports; tests advance it like a real chain. */
  head: number;
  /** Per-call Telegram answer; overrides telegramStatus when it returns a value. */
  telegramReply?: (method: string, body: any) => { status: number; json: unknown } | undefined;
}

export function installChain(t: TestContext): Chain {
  const chain: Chain = {
    keys: {
      "a.kd-demo.testnet": fixture("rpc/view_access_key_list.a.json"),
      "b.kd-demo.testnet": fixture("rpc/view_access_key_list.b.json"),
      "c.kd-demo.testnet": fixture("rpc/view_access_key_list.c.json"),
    },
    calls: [],
    views: { get_last_proposal_id: () => bytes(4) },
    telegram: [],
    telegramStatus: 200,
    head: HEAD,
  };
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const tg = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
    if (tg) {
      const sentBody = JSON.parse(String(init?.body));
      chain.telegram.push({ method: tg[1] as string, body: sentBody });
      const custom = chain.telegramReply?.(tg[1] as string, sentBody);
      if (custom) return new Response(JSON.stringify(custom.json), { status: custom.status });
      const ok = chain.telegramStatus === 200;
      return new Response(JSON.stringify(ok ? { ok: true, result: {} } : { ok: false, description: "Forbidden: bot was blocked by the user" }), { status: chain.telegramStatus });
    }
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, any> };
    chain.calls.push({ method: body.method, ...body.params });
    const p = body.params;
    let reply: unknown;
    if (body.method === "block") reply = ok({ header: { height: chain.head, hash: "h", timestamp_nanosec: `${1793671210000 + (chain.head - HEAD) * 1200}000000` }, chunks: [] });
    else if (p.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString() || "{}");
      const view = chain.views[p.method_name];
      if (view) reply = view(args);
      else if (p.account_id === DAO && p.method_name === "get_policy") reply = fixture("rpc/call_function.get_policy.json");
      else reply = ok({ error: "wasm execution failed with error: CompilationError(CodeDoesNotExist)", logs: [] });
    } else if (p.request_type === "view_access_key_list") reply = chain.keys[p.account_id] ?? unknownAccount;
    else if (p.request_type === "view_account") reply = p.account_id === "game.kd-demo.testnet" ? fixture("rpc/view_account.game.json") : unknownAccount;
    else return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return chain;
}

/** Adds a fresh full-access key to an account in the stub chain. */
export function addKey(chain: Chain, account: string, publicKey: string, block = HEAD - 100): void {
  const body = structuredClone(chain.keys[account]);
  body.result.keys.push({ public_key: publicKey, access_key: { nonce: block * 1_000_000, permission: "FullAccess" } });
  chain.keys[account] = body;
}
