// Test helper (not a spec): a stubbed `globalThis.fetch` that answers JSON-RPC
// requests by method, request_type and account_id, and records every request.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");
export const loadJson = <T = any>(rel: string): T => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;

export const HEAD = 182340111;
export const HEAD_TS_MS = 1793671210000;
export const STUB_URL = "https://rpc.stub.invalid/KD_FAKE_API_KEY_12345";

export interface Recorded {
  method: string;
  params: Record<string, any>;
  key: string;
}

export type Answer = unknown | ((req: Recorded) => Response | Promise<Response>);

/** `block`, or `query/<request_type>/<account_id>` (`call_function` too). */
export const keyOf = (method: string, params: Record<string, any>): string =>
  method === "block" ? "block" : `${method}/${params.request_type}/${params.account_id}`;

export interface Stub {
  requests: Recorded[];
  /** Requests with no configured answer; each one was answered with HTTP 500. */
  unmatched: string[];
  maxInFlight: () => number;
  restore: () => void;
}

export function installStub(answers: Record<string, Answer>): Stub {
  const original = globalThis.fetch;
  const requests: Recorded[] = [];
  const unmatched: string[] = [];
  let inFlight = 0;
  let max = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: Record<string, any> };
    const rec: Recorded = { method: body.method, params: body.params, key: keyOf(body.method, body.params) };
    requests.push(rec);
    inFlight += 1;
    max = Math.max(max, inFlight);
    try {
      // Yield so that concurrent requests really overlap.
      await new Promise((r) => setTimeout(r, 2));
      const a = answers[rec.key];
      if (a === undefined) {
        unmatched.push(rec.key);
        return new Response("{}", { status: 500 });
      }
      if (typeof a === "function") return await (a as (r: Recorded) => Response | Promise<Response>)(rec);
      return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return { requests, unmatched, maxInFlight: () => max, restore: () => void (globalThis.fetch = original) };
}

// ---- raw JSON-RPC body builders -------------------------------------------------

const ok = (result: unknown) => ({ jsonrpc: "2.0", id: "kd", result });
export const blockBody = (height = HEAD, tsMs = HEAD_TS_MS) =>
  ok({ author: "validator.testnet", header: { height, hash: "x", timestamp_nanosec: `${BigInt(tsMs) * 1_000_000n}` }, chunks: [] });
export const accountBody = () => loadJson("rpc/view_account.empty-target.json");
export const unknownAccountBody = () => loadJson("rpc/error.unknown_account.json");
export const causeBody = (name: string) => ({
  jsonrpc: "2.0",
  id: "kd",
  error: { code: -32000, message: "Server error", data: "SECRET_BODY_TEXT", name: "HANDLER_ERROR", cause: { name, info: {} } },
});
export const policyBody = (policy: unknown) =>
  ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(policy))), logs: [], block_height: HEAD, block_hash: "x" });

export type RawKeyJson = { public_key: string; access_key: { nonce: number | string; permission: unknown } };
export const keysBody = (keys: RawKeyJson[]) => ok({ block_hash: "x", block_height: HEAD, keys });

let pkCounter = 0;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function pk(prefix = "ed25519"): string {
  let n = ++pkCounter;
  let s = "";
  for (let i = 0; i < 44; i++) {
    s += B58[n % B58.length];
    n = Math.floor(n / B58.length) + i + 7;
  }
  return `${prefix}:${s}`;
}
/** Nonce for a key added at `block` and used `uses` times. */
export const nonceAt = (block: number, uses: number): number => block * 1_000_000 + uses;
export const RECENT = 182_000_000;
export const faKey = (uses = 5, block = RECENT, prefix = "ed25519"): RawKeyJson => ({
  public_key: pk(prefix),
  access_key: { nonce: nonceAt(block, uses), permission: "FullAccess" },
});
export const fcKey = (
  receiver: string,
  methods: string[],
  allowance: string | null = "250000000000000000000000",
  uses = 5,
): RawKeyJson => ({
  public_key: pk(),
  access_key: {
    nonce: nonceAt(RECENT, uses),
    permission: { FunctionCall: { allowance, receiver_id: receiver, method_names: methods } },
  },
});

export const groupRole = (name: string, members: string[], permissions: string[], vote_policy: Record<string, unknown> = {}) => ({
  name,
  kind: { Group: members },
  permissions,
  vote_policy,
});
export const policyOf = (roles: unknown[], defaultThreshold: unknown = [1, 2]) => ({
  roles,
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: defaultThreshold },
  proposal_bond: "100000000000000000000000",
  proposal_period: "604800000000000",
  bounty_bond: "100000000000000000000000",
  bounty_forgiveness_period: "86400000000000",
});

/** The standard answers for a DAO whose members all hold `keys[id]`. */
export function daoAnswers(
  daoId: string,
  policy: unknown,
  keys: Record<string, RawKeyJson[]>,
  extra: Record<string, Answer> = {},
): Record<string, Answer> {
  const a: Record<string, Answer> = {
    block: blockBody(),
    [`query/call_function/${daoId}`]: policyBody(policy),
  };
  for (const [id, ks] of Object.entries(keys)) a[`query/view_access_key_list/${id}`] = keysBody(ks);
  return { ...a, ...extra };
}

/** Builds a Response for a stubbed answer function. */
export const http = (status: number, body: unknown = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
