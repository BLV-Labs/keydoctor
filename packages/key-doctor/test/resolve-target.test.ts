import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isKdError, resolveTarget, scanAccount, scanDao } from "../src/index.ts";
import { installFetch, world } from "./support/stub.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(isKdError(e), "throws a KdErrorException");
    return e.kd;
  }
  assert.fail("did not throw");
};
const ok = (n: number) => "a".repeat(n - ".testnet".length) + ".testnet";

describe("S1-AC4: resolveTarget", () => {
  it("length edges of the account id regex", () => {
    for (const bad of ["a", "", "a".repeat(65), "a".repeat(57) + ".testnet"]) {
      assert.equal(code(() => resolveTarget(bad)).code, "INVALID_TARGET", bad.length.toString());
    }
    assert.equal(resolveTarget("ab").id, "ab");
    assert.equal(resolveTarget("g".repeat(64)).kind, "named"); // not hex
    assert.equal(resolveTarget(ok(64)).id.length, 64);
    assert.equal(code(() => resolveTarget(ok(65))).code, "INVALID_TARGET");
  });

  it("rejects malformed ids", () => {
    for (const bad of ["-a", "a-", "a..b", "a b", "a/b", ".testnet", "a.", "a__b", "a@b"]) {
      assert.equal(code(() => resolveTarget(bad)).code, "INVALID_TARGET", JSON.stringify(bad));
    }
    assert.equal(code(() => resolveTarget(undefined as unknown as string)).code, "INVALID_TARGET");
  });

  it("trims and lowercases", () => {
    assert.equal(resolveTarget("  KD-Demo.TESTNET \n").id, "kd-demo.testnet");
  });

  it("64-hex is implicit; 0x target is refused with the eth text", () => {
    assert.deepEqual(resolveTarget("ab".repeat(32)), { id: "ab".repeat(32), network: "testnet", kind: "implicit" });
    const e = code(() => resolveTarget("0x" + "ab".repeat(20)));
    assert.equal(e.code, "INVALID_TARGET");
    assert.match(e.message.en, /Ethereum-style accounts are not supported/);
    assert.equal(e.retryable, false);
  });

  it("network: suffix decides, a conflict throws, none defaults to testnet", () => {
    assert.equal(resolveTarget("a.testnet").network, "testnet");
    assert.equal(resolveTarget("a.near").network, "mainnet");
    assert.equal(resolveTarget("a.near", { network: "mainnet" }).network, "mainnet");
    assert.equal(resolveTarget("a.testnet", { network: "testnet" }).network, "testnet");
    assert.match(code(() => resolveTarget("a.near", { network: "testnet" })).message.en, /suffix does not match/);
    assert.match(code(() => resolveTarget("a.testnet", { network: "mainnet" })).message.en, /suffix does not match/);
    assert.equal(resolveTarget("abc").network, "testnet");
    assert.equal(resolveTarget("abc", { network: "mainnet" }).network, "mainnet");
  });

  it("blockHeight must be a safe integer >= 1", () => {
    assert.equal(resolveTarget("a.testnet", { blockHeight: 1 }).id, "a.testnet");
    assert.equal(resolveTarget("a.testnet", { blockHeight: 2 ** 53 - 1 }).id, "a.testnet");
    for (const h of [0, -1, 1.5, 2 ** 53, NaN, Infinity]) {
      const e = code(() => resolveTarget("a.testnet", { blockHeight: h }));
      assert.equal(e.code, "INVALID_TARGET");
      assert.match(e.message.en, /block height/);
    }
  });

  it("the error text never echoes the input", () => {
    const e = code(() => resolveTarget("SECRET<script>.testnet?x"));
    assert.doesNotMatch(JSON.stringify(e), /SECRET|script/i);
  });

  it("scanAccount and scanDao reject a bad target with zero fetch calls", async (t) => {
    const calls = installFetch(t, world({}));
    for (const fn of [scanAccount, scanDao]) {
      for (const [id, opts] of [
        ["bad id", {}],
        ["0x" + "ab".repeat(20), {}],
        ["a.near", { network: "testnet" as const }],
        ["a.testnet", { blockHeight: 0 }],
      ] as const) {
        await assert.rejects(fn(id, opts), (e) => isKdError(e) && e.kd.code === "INVALID_TARGET");
      }
    }
    assert.equal(calls.length, 0);
  });
});
