import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isKdError, scanAccount } from "../src/index.ts";
import { createRpc, DEFAULT_RPC_URLS } from "../src/rpc.ts";
import { ed, installFetch, rpcErr, world, type Req } from "./support/stub.ts";

const ID = "a.kd-demo.testnet";
const A = "https://rpc-a.example.test";
const B = "https://rpc-b.example.test";
const good = world({ keys: { [ID]: [ed(1)] } });
const status = (code: number) => new Response("x", { status: code });
const hosts = (calls: Req[]) => calls.map((c) => (c.url === A ? "A" : c.url === B ? "B" : c.url));

describe("RPC failover across endpoints", () => {
  it("defaults to FastNEAR first and near.org as the fallback", () => {
    assert.deepEqual(DEFAULT_RPC_URLS.testnet, ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"]);
    assert.deepEqual(DEFAULT_RPC_URLS.mainnet, ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"]);
  });

  it("a scan with no rpcUrl starts on the first default endpoint", async (t) => {
    const calls = installFetch(t, good);
    await scanAccount(ID);
    assert.ok(calls.every((c) => c.url === DEFAULT_RPC_URLS.testnet[0]));
  });

  for (const [label, reply] of [
    ["429", () => status(429)],
    ["503", () => status(503)],
    ["403", () => status(403)],
    ["unreadable body", () => new Response("<html>", { status: 200 })],
    ["UNKNOWN_BLOCK (a lagging node)", () => rpcErr("UNKNOWN_BLOCK")],
  ] as const) {
    it(`moves to the next endpoint on ${label} and stays there`, async (t) => {
      const calls = installFetch(t, (r) => (r.url === A && r.method !== "block" ? reply() : good(r)));
      const report = await scanAccount(ID, { rpcUrl: [A, B] });
      assert.equal(report.members[0]?.keys.length, 1);
      // block on A, key list fails on A then succeeds on B, every later call goes straight to B.
      assert.deepEqual(hosts(calls).slice(0, 3), ["A", "A", "B"]);
      assert.ok(hosts(calls).slice(2).every((h) => h === "B"));
    });
  }

  it("a network error moves on too", async (t) => {
    const calls = installFetch(t, (r) => {
      if (r.url === A) throw new TypeError("fetch failed");
      return good(r);
    });
    await scanAccount(ID, { rpcUrl: [A, B] });
    assert.deepEqual(hosts(calls).slice(0, 2), ["A", "B"]);
  });

  it("a JSON-RPC answer is final: UNKNOWN_ACCOUNT does not try the next endpoint", async (t) => {
    const calls = installFetch(t, (r) => (r.method === "block" ? good(r) : rpcErr("UNKNOWN_ACCOUNT")));
    await assert.rejects(scanAccount(ID, { rpcUrl: [A, B] }), (e) => isKdError(e) && e.kd.code === "NOT_FOUND");
    assert.ok(calls.every((c) => c.url === A));
  });

  it("when every endpoint is rate-limited, it waits once, tries them all again, then fails with RATE_LIMITED", async (t) => {
    const calls = installFetch(t, () => status(429));
    const rpc = createRpc({ url: [A, B], rateLimitBackoffMs: 1 });
    await assert.rejects(rpc.block(), (e) => isKdError(e) && e.kd.code === "RATE_LIMITED" && e.kd.retryable);
    assert.deepEqual(hosts(calls), ["A", "B", "A", "B"]);
  });

  it("the backoff round succeeds once a limit lifts", async (t) => {
    let n = 0;
    const calls = installFetch(t, (r) => (++n <= 2 ? status(429) : good(r)));
    await createRpc({ url: [A, B], rateLimitBackoffMs: 1 }).block();
    assert.deepEqual(hosts(calls), ["A", "B", "A"]);
  });

  it("no backoff round when one endpoint failed for another reason", async (t) => {
    const calls = installFetch(t, (r) => (r.url === A ? status(429) : status(503)));
    await assert.rejects(createRpc({ url: [A, B], rateLimitBackoffMs: 1 }).block(), (e) => isKdError(e) && e.kd.code === "RPC_ERROR");
    assert.deepEqual(hosts(calls), ["A", "B"]);
  });

  it("goes back to the first endpoint when the one in use fails later", async (t) => {
    const down = new Set<string>();
    const calls = installFetch(t, (r) => (down.has(r.url) ? status(429) : good(r)));
    const rpc = createRpc({ url: [A, B] });
    down.add(A);
    await rpc.block(); // A 429 -> B
    down.clear();
    await rpc.block(); // stays on B
    down.add(B);
    await rpc.block(); // B 429 -> A
    assert.deepEqual(hosts(calls), ["A", "B", "B", "B", "A"]);
  });
});
