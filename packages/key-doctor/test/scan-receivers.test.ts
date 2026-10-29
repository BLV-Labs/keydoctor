import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanAccount } from "../src/index.ts";
import { AGE_LIMITATION, RECEIVERS_UNCHECKED_LIMITATION } from "../src/messages.ts";
import { REQUEST_BUDGET } from "../src/rules/thresholds.ts";
import { FA, HEAD, ed, fc, fixture, installFetch, rpcErr, world } from "./support/stub.ts";

const ID = "a.kd-demo.testnet";
const fcKey = (i: number, receiver: string) => ed(i, undefined, fc(receiver));
const viewAccountCalls = (calls: ReturnType<typeof installFetch>) =>
  calls.filter((c) => c.params.request_type === "view_account").map((c) => String(c.params.account_id));

describe("S2-AC2: receiver checks", () => {
  it("each distinct receiver is checked once, pinned to the head block", async (t) => {
    const calls = installFetch(t, world({ keys: { [ID]: [fcKey(1, "x.testnet"), fcKey(2, "x.testnet"), fcKey(3, "y.testnet")] } }));
    const r = await scanAccount(ID);
    assert.deepEqual(viewAccountCalls(calls).sort(), ["x.testnet", "y.testnet"]);
    for (const c of calls.slice(1)) assert.equal(c.params.block_id, HEAD);
    assert.deepEqual(r.members[0]!.keys.map((k) => k.receiver_exists), [true, true, true]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.limitations, [AGE_LIMITATION]);
  });

  it("UNKNOWN_ACCOUNT gives false on every key with that receiver; no error line", async (t) => {
    installFetch(t, world({ keys: { [ID]: [fcKey(1, "gone.testnet"), fcKey(2, "gone.testnet"), fcKey(3, "here.testnet")] }, missing: ["gone.testnet"] }));
    const r = await scanAccount(ID);
    assert.deepEqual(r.members[0]!.keys.map((k) => k.receiver_exists), [false, false, true]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.members[0]!.flags.filter((f) => f.rule_id === "FC_DEAD_RECEIVER").length, 2);
  });

  it("another failure gives null plus a 'receiver <id>: <CODE>' line, ordered by receiver id; no dead-receiver flag", async (t) => {
    installFetch(
      t,
      world({
        keys: { [ID]: [fcKey(1, "b.testnet"), fcKey(2, "a.testnet"), fcKey(3, "c.testnet")] },
        viewAccount: {
          "b.testnet": new Response("SECRET", { status: 500 }),
          "a.testnet": new Response("SECRET", { status: 429 }),
        },
      }),
    );
    const r = await scanAccount(ID);
    assert.deepEqual(r.errors, ["receiver a.testnet: RATE_LIMITED", "receiver b.testnet: RPC_ERROR"]);
    assert.deepEqual(r.members[0]!.keys.map((k) => k.receiver_exists), [null, null, true]);
    assert.equal(r.members[0]!.flags.some((f) => f.rule_id === "FC_DEAD_RECEIVER"), false);
    assert.equal(r.members[0]!.error, null);
    assert.deepEqual(r.limitations, [AGE_LIMITATION]);
  });

  it("a non-UNKNOWN_ACCOUNT rpc error cause on a receiver is a code line, not false", async (t) => {
    installFetch(t, world({ keys: { [ID]: [fcKey(1, "a.testnet")] }, viewAccount: { "a.testnet": rpcErr("UNKNOWN_BLOCK") } }));
    const r = await scanAccount(ID);
    assert.equal(r.members[0]!.keys[0]!.receiver_exists, null);
    assert.deepEqual(r.errors, ["receiver a.testnet: RPC_ERROR"]);
  });

  it("skipReceiverCheck: no view_account request, null, one limitation line", async (t) => {
    const calls = installFetch(t, world({ keys: { [ID]: [fcKey(1, "a.testnet"), fcKey(2, "b.testnet")] }, missing: ["a.testnet"] }));
    const r = await scanAccount(ID, { skipReceiverCheck: true });
    assert.deepEqual(viewAccountCalls(calls), []);
    assert.deepEqual(r.members[0]!.keys.map((k) => k.receiver_exists), [null, null]);
    assert.deepEqual(r.limitations, [AGE_LIMITATION, RECEIVERS_UNCHECKED_LIMITATION]);
    assert.deepEqual(r.errors, []);
  });

  it("a receiver id that fails the account-id check gets no request, null and the limitation line", async (t) => {
    const calls = installFetch(
      t,
      world({ keys: { [ID]: [fcKey(1, "Upper.testnet"), fcKey(2, "has space"), fcKey(3, "ok.testnet")] } }),
    );
    const r = await scanAccount(ID);
    assert.deepEqual(viewAccountCalls(calls), ["ok.testnet"]);
    assert.deepEqual(r.members[0]!.keys.map((k) => k.receiver_exists), [null, null, true]);
    assert.deepEqual(r.limitations, [AGE_LIMITATION, RECEIVERS_UNCHECKED_LIMITATION]);
  });

  it("over the request budget: the first receivers in code-unit order are checked, the rest skipped", async (t) => {
    const n = 50;
    const names = Array.from({ length: n }, (_, i) => `r${String(i).padStart(2, "0")}.testnet`);
    // keys listed in reverse so key order differs from sorted order
    const keys = [...names].reverse().map((name, i) => fcKey(i, name));
    const calls = installFetch(t, world({ keys: { [ID]: keys } }));
    const r = await scanAccount(ID);
    const slots = REQUEST_BUDGET - 2;
    assert.equal(calls.length, REQUEST_BUDGET);
    assert.deepEqual(viewAccountCalls(calls).sort(), names.slice(0, slots));
    const byReceiver = new Map(r.members[0]!.keys.map((k) => [(k.permission as { receiver_id: string }).receiver_id, k.receiver_exists]));
    assert.deepEqual(names.slice(0, slots).map((x) => byReceiver.get(x)), Array(slots).fill(true));
    assert.deepEqual(names.slice(slots).map((x) => byReceiver.get(x)), Array(n - slots).fill(null));
    assert.deepEqual(r.limitations, [AGE_LIMITATION, RECEIVERS_UNCHECKED_LIMITATION]);
  });

  it("an empty key list sends exactly block, key list and the follow-up", async (t) => {
    const calls = installFetch(t, world({ keys: { [ID]: [] } }));
    await scanAccount(ID);
    assert.equal(calls.length, 3);
  });

  it("FA keys carry no receiver_exists field at all", async (t) => {
    installFetch(t, world({ keys: { [ID]: [ed(1, undefined, FA), fcKey(2, "x.testnet")] } }));
    const r = await scanAccount(ID);
    assert.equal("receiver_exists" in r.members[0]!.keys[0]!, false);
    assert.equal("receiver_exists" in r.members[0]!.keys[1]!, true);
  });
});

describe("S2-AC3: the b.kd-demo.testnet fixture report", () => {
  it("deep-equals fixtures/reports/account-b.report.json except generated_at", async (t) => {
    const B = "b.kd-demo.testnet";
    const calls = installFetch(t, (req) => {
      if (req.method === "block") return fixture("rpc/block.json");
      if (req.params.request_type === "view_access_key_list") {
        return req.params.account_id === B ? fixture("rpc/view_access_key_list.b.json") : rpcErr("UNKNOWN_ACCOUNT");
      }
      if (req.params.request_type === "view_account") {
        return req.params.account_id === "game.kd-demo.testnet" ? fixture("rpc/view_account.game.json") : rpcErr("UNKNOWN_ACCOUNT");
      }
      return rpcErr("UNKNOWN_METHOD");
    });
    const report = await scanAccount(B);
    const expected = fixture("reports/account-b.report.json");
    const { generated_at: g1, ...got } = report;
    const { generated_at: g2, ...want } = expected;
    assert.match(g1, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(g2);
    assert.deepEqual(got, want);
    assert.equal(calls.length, 3);
  });
});

