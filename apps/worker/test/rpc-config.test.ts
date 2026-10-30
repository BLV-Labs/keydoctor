import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rpcUrlsFor } from "../src/core.ts";
import type { Env } from "../src/env.ts";

const env = (vars: Partial<Env>) => vars as Env;

describe("RPC_URL_* config", () => {
  it("splits a comma-separated list per network, in order", () => {
    const e = env({ RPC_URL_TESTNET: " https://a.test , https://b.test ,", RPC_URL_MAINNET: "https://m.test" });
    assert.deepEqual(rpcUrlsFor(e, "testnet"), ["https://a.test", "https://b.test"]);
    assert.deepEqual(rpcUrlsFor(e, "mainnet"), ["https://m.test"]);
  });

  it("unset or empty falls back to the library default", () => {
    assert.equal(rpcUrlsFor(env({}), "testnet"), undefined);
    assert.equal(rpcUrlsFor(env({ RPC_URL_MAINNET: " , " }), "mainnet"), undefined);
  });
});
