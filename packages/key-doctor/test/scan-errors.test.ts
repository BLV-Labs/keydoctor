import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { isKdError, scanAccount } from "../src/index.ts";
import type { KdErrorCode } from "../src/index.ts";
import { MAX_KEYS, RPC_TIMEOUT_MS } from "../src/rules/thresholds.ts";
import { HEAD, blockBody, ed, installFetch, ok, rawKey, rpcErr, world, type Req, type Reply } from "./support/stub.ts";

const ID = "a.kd-demo.testnet";
const URL_WITH_KEY = "https://rpc.example.test/v1/API-KEY-12345";
const text = (body: string, status = 200) => new Response(body, { status });

/** The thrown value is a KdErrorException with no URL, body text or cause in it. */
function assertClean(e: unknown): asserts e is { kd: { code: KdErrorCode; retryable: boolean; message: { vi: string; en: string } } } {
  assert.ok(isKdError(e), "isKdError");
  assert.equal(Object.hasOwn(e, "cause"), false, "no cause");
  assert.equal(e.cause, undefined);
  const dump = JSON.stringify({ m: e.message, kd: e.kd, n: e.name, s: e.stack });
  assert.doesNotMatch(dump, /API-KEY|rpc\.example|SECRET|https?:/);
  assert.ok(e.kd.message.vi.length > 0 && e.kd.message.en.length > 0);
}

async function fails(t: TestContext, route: (r: Req) => Reply, opts = {}) {
  const calls = installFetch(t, route);
  try {
    await scanAccount(ID, { rpcUrl: URL_WITH_KEY, ...opts });
  } catch (e) {
    assertClean(e);
    return { kd: e.kd, calls };
  }
  assert.fail("scanAccount did not throw");
}
const base = (over: (r: Req) => Reply | undefined) => (r: Req) => over(r) ?? world({ keys: { [ID]: [ed(1)] } })(r);
const onKeyList = (reply: Reply) => base((r) => (r.params.request_type === "view_access_key_list" ? reply : undefined));

describe("S1-AC5: HTTP and transport failures", () => {
  const table: Array<[string, () => Reply, KdErrorCode, boolean]> = [
    ["HTTP 429", () => text("SECRET", 429), "RATE_LIMITED", true],
    ["HTTP 500", () => text("SECRET", 500), "RPC_ERROR", true],
    ["HTTP 503", () => text("SECRET", 503), "RPC_ERROR", true],
    ["HTTP 404 (not in the table: not retryable)", () => text("SECRET", 404), "RPC_ERROR", false],
    ["non-JSON body", () => text("<html>SECRET API-KEY-12345</html>"), "RPC_ERROR", true],
    ["body with neither result nor error", () => ({ jsonrpc: "2.0", id: "kd" }), "RPC_ERROR", true],
    ["JSON array body", () => [], "RPC_ERROR", true],
    ["JSON null body", () => text("null"), "RPC_ERROR", true],
    ["cause UNKNOWN_ACCOUNT", () => rpcErr("UNKNOWN_ACCOUNT"), "NOT_FOUND", false],
    ["cause UNKNOWN_BLOCK", () => rpcErr("UNKNOWN_BLOCK"), "RPC_ERROR", true],
    ["cause GARBAGE_COLLECTED_BLOCK", () => rpcErr("GARBAGE_COLLECTED_BLOCK"), "RPC_ERROR", false],
    ["cause NO_CONTRACT_CODE on a non get_policy call", () => rpcErr("NO_CONTRACT_CODE"), "RPC_ERROR", false],
    ["cause CONTRACT_EXECUTION_ERROR on a non get_policy call", () => rpcErr("CONTRACT_EXECUTION_ERROR"), "RPC_ERROR", false],
    ["old-style result.error string", () => ok({ error: "SECRET wasm execution failed" }), "RPC_ERROR", false],
    ["error object without cause", () => ({ jsonrpc: "2.0", id: "kd", error: { message: "SECRET" } }), "RPC_ERROR", false],
    ["keys is not an array", () => ok({ keys: "SECRET" }), "RPC_ERROR", true],
    ["a key with a bad permission", () => ok({ keys: [rawKey("ed25519:x", 1, { Weird: 1 })] }), "RPC_ERROR", true],
    ["a key with a negative nonce", () => ok({ keys: [rawKey("ed25519:x", -1, "FullAccess")] }), "RPC_ERROR", true],
  ];
  for (const [name, reply, code, retryable] of table) {
    it(`${name} on the key list gives ${code}, retryable ${retryable}, no retry`, async (t) => {
      const { kd, calls } = await fails(t, onKeyList(reply()));
      assert.equal(kd.code, code);
      assert.equal(kd.retryable, retryable);
      assert.equal(calls.length, 2, "block + one key-list attempt, no retry");
    });
  }

  it("a network TypeError that quotes the URL gives RPC_ERROR without URL or cause", async (t) => {
    const { kd } = await fails(t, () => {
      throw new TypeError(`fetch failed: ${URL_WITH_KEY}`);
    });
    assert.deepEqual([kd.code, kd.retryable], ["RPC_ERROR", true]);
  });

  it("an abort error gives RPC_ERROR retryable", async (t) => {
    const { kd } = await fails(t, () => {
      throw new DOMException(`aborted ${URL_WITH_KEY}`, "AbortError");
    });
    assert.deepEqual([kd.code, kd.retryable], ["RPC_ERROR", true]);
  });

  it("block-call failures: UNKNOWN_BLOCK is retryable unless the caller pinned the block", async (t) => {
    const route = () => rpcErr("UNKNOWN_BLOCK");
    assert.equal((await fails(t, route)).kd.retryable, true);
    const pinned = await fails(t, route, { blockHeight: 1234 });
    assert.deepEqual([pinned.kd.code, pinned.kd.retryable], ["RPC_ERROR", false]);
    assert.equal(pinned.calls.length, 1);
  });

  it("UNKNOWN_BLOCK on a later call stays retryable even when blockHeight was given", async (t) => {
    const { kd } = await fails(t, onKeyList(rpcErr("UNKNOWN_BLOCK")), { blockHeight: 1234 });
    assert.equal(kd.retryable, true);
  });

  it("a malformed block response gives RPC_ERROR", async (t) => {
    for (const body of [
      ok({}),
      ok({ header: { height: 0, timestamp_nanosec: "1" } }),
      ok({ header: { height: 1.5, timestamp_nanosec: "1" } }),
      ok({ header: { height: HEAD, timestamp_nanosec: 12 } }),
      ok({ header: { height: HEAD, timestamp_nanosec: "12x" } }),
    ]) {
      const { kd } = await fails(t, () => body);
      assert.equal(kd.code, "RPC_ERROR");
    }
  });
});

describe("S1-AC5: 15 s timeout (mock timers)", () => {
  /** Runs a scan whose first fetch hangs/stalls; returns once settled. */
  async function timedOut(t: TestContext, hang: (signal: AbortSignal) => Reply) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    installFetch(t, function (this: RequestInit) {
      return hang(this.signal as AbortSignal);
    });
    let settled = false;
    const p = scanAccount(ID, { rpcUrl: URL_WITH_KEY }).then(
      () => assert.fail("resolved"),
      (e: unknown) => {
        settled = true;
        return e;
      },
    );
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(RPC_TIMEOUT_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "still waiting one ms before the timeout");
    t.mock.timers.tick(1);
    return p;
  }
  const rejectOnAbort = (signal: AbortSignal) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException(`aborted ${URL_WITH_KEY}`, "AbortError"))));

  it("RPC_TIMEOUT_MS is 15 s", () => assert.equal(RPC_TIMEOUT_MS, 15_000));

  it("a request that never answers aborts at 15 s and maps to RPC_ERROR retryable", async (t) => {
    const e = await timedOut(t, rejectOnAbort);
    assertClean(e);
    assert.deepEqual([e.kd.code, e.kd.retryable], ["RPC_ERROR", true]);
  });

  it("a stalled body read (headers sent, body never ends) also times out", async (t) => {
    const e = await timedOut(
      t,
      (signal) =>
        new Response(
          new ReadableStream({
            start(c) {
              signal.addEventListener("abort", () => c.error(new TypeError(`stalled ${URL_WITH_KEY}`)));
            },
          }),
          { status: 200 },
        ),
    );
    assertClean(e);
    assert.deepEqual([e.kd.code, e.kd.retryable], ["RPC_ERROR", true]);
  });
});

describe("S1-AC5: follow-up and caps", () => {
  it("empty key list + view_account UNKNOWN_ACCOUNT throws NOT_FOUND", async (t) => {
    const route = (r: Req) =>
      r.method === "block" ? blockBody() : r.params.request_type === "view_account" ? rpcErr("UNKNOWN_ACCOUNT") : ok({ keys: [] });
    const { kd, calls } = await fails(t, route);
    assert.deepEqual([kd.code, kd.retryable], ["NOT_FOUND", false]);
    assert.equal(calls.length, 3);
  });

  it("empty key list + view_account failure throws the mapped error", async (t) => {
    const route = (r: Req) =>
      r.method === "block" ? blockBody() : r.params.request_type === "view_account" ? text("SECRET", 500) : ok({ keys: [] });
    assert.equal((await fails(t, route)).kd.code, "RPC_ERROR");
  });

  it("view_account answering with no amount is a shape error", async (t) => {
    const route = (r: Req) =>
      r.method === "block" ? blockBody() : r.params.request_type === "view_account" ? ok({}) : ok({ keys: [] });
    assert.equal((await fails(t, route)).kd.code, "RPC_ERROR");
  });

  const keys = (n: number) => Array.from({ length: n }, (_, i) => ed(i));

  it("MAX_KEYS + 1 keys throws LIMIT_EXCEEDED naming the cap, before any receiver request", async (t) => {
    const { kd, calls } = await fails(t, world({ keys: { [ID]: keys(MAX_KEYS + 1) } }));
    assert.deepEqual([kd.code, kd.retryable], ["LIMIT_EXCEEDED", false]);
    assert.match(kd.message.en, new RegExp(`more than ${MAX_KEYS} keys`));
    assert.match(kd.message.vi, new RegExp(`${MAX_KEYS}`));
    assert.equal(calls.length, 2);
  });

  it("exactly MAX_KEYS keys is scanned", async (t) => {
    installFetch(t, world({ keys: { [ID]: keys(MAX_KEYS) } }));
    const r = await scanAccount(ID);
    assert.equal(r.members[0]!.keys.length, MAX_KEYS);
  });
});

describe("scanTarget", () => {
  it("falls back to scanAccount on NOT_A_DAO and keeps other errors", async (t) => {
    const { scanTarget } = await import("../src/index.ts");
    const { installFetch, blockBody, ok, fixture, rpcErr } = await import("./support/stub.ts");
    installFetch(t, (req) => {
      if (req.method === "block") return blockBody();
      if (req.params.request_type === "call_function") return ok({ error: "wasm execution failed: CodeDoesNotExist", logs: [] });
      if (req.params.request_type === "view_access_key_list" && req.params.account_id === "b.kd-demo.testnet") return fixture("rpc/view_access_key_list.b.json");
      return rpcErr("UNKNOWN_ACCOUNT");
    });
    const r = await scanTarget("b.kd-demo.testnet", { skipReceiverCheck: true });
    assert.equal(r.target.type, "account");
    await assert.rejects(scanTarget("nobody.kd-demo.testnet"), (e: any) => e.kd?.code === "NOT_FOUND");
  });
});
