import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { scanAccount } from "../src/index.ts";
import type { KdReport } from "../src/index.ts";
import { GENESIS_HEIGHT } from "../src/rules/thresholds.ts";
import { FA, HEAD, HEAD_TS_SEC, RECENT, ed, fc, installFetch, iso, ml, nonceAt, rawKey, world } from "./support/stub.ts";

const ID = "a.kd-demo.testnet";

async function run(
  t: TestContext,
  keys: unknown[],
  w: { missing?: string[] } = {},
  id = ID,
): Promise<{ report: KdReport; calls: ReturnType<typeof installFetch> }> {
  const calls = installFetch(t, world({ keys: { [id]: keys }, ...w }));
  return { report: await scanAccount(id), calls };
}
const flagIds = (r: KdReport) => r.members[0]!.flags.map((f) => f.rule_id);
const keyFlags = (r: KdReport) => r.members[0]!.keys.map((k) => k.flag_ids);
const eds = (n: number) => Array.from({ length: n }, (_, i) => ed(i));

describe("S1-AC1: scanAccount pins every query to the head block", () => {
  it("block first with finality final, then every query carries block_id", async (t) => {
    const { report, calls } = await run(t, [ed(1), ed(2, RECENT, fc("game.kd-demo.testnet"))]);
    assert.equal(calls[0]!.method, "block");
    assert.deepEqual(calls[0]!.params, { finality: "final" });
    assert.ok(calls.length >= 3);
    for (const c of calls.slice(1)) assert.equal(c.params.block_id, HEAD);
    assert.equal(report.schema_version, "kd.report.v1");
    assert.deepEqual(report.target, { type: "account", id: ID });
    assert.equal(report.chain.block_height, HEAD);
    assert.equal(report.chain.block_timestamp, iso(HEAD_TS_SEC));
    assert.equal(report.members.length, 1);
  });

  it("opts.blockHeight goes into the block call and the later calls use the returned head", async (t) => {
    const calls = installFetch(t, world({ keys: { [ID]: [ed(1)] } }));
    await scanAccount(ID, { blockHeight: 182340000 });
    assert.deepEqual(calls[0]!.params, { block_id: 182340000 });
    assert.equal(calls[1]!.params.block_id, HEAD);
  });
});

describe("S1-AC2: account rules at their thresholds", () => {
  it("FA_MANY fires at 5 ed25519 FA keys, suppresses FA_MULTIPLE, tags every ed key", async (t) => {
    const { report } = await run(t, eds(5));
    assert.deepEqual(flagIds(report), ["FA_MANY", "PQ_NONE"]);
    assert.deepEqual(keyFlags(report), Array(5).fill(["FA_MANY"]));
    const f = report.members[0]!.flags[0]!;
    assert.equal(f.severity, "high");
    assert.deepEqual(f.evidence, { full_access_ed25519: 5 });
    assert.equal(report.members[0]!.status, "high");
    assert.equal(report.summary.status, "high");
  });

  it("4 ed25519 FA keys give FA_MULTIPLE only (one below FA_MANY)", async (t) => {
    const { report } = await run(t, eds(4));
    assert.deepEqual(flagIds(report), ["FA_MULTIPLE", "PQ_NONE"]);
    assert.deepEqual(keyFlags(report), Array(4).fill(["FA_MULTIPLE"]));
    assert.equal(report.members[0]!.status, "cleanup");
  });

  it("FA_MULTIPLE fires at 2 and not at 1", async (t) => {
    assert.deepEqual(flagIds((await run(t, eds(2))).report), ["FA_MULTIPLE", "PQ_NONE"]);
    const one = (await run(t, eds(1))).report;
    assert.deepEqual(flagIds(one), ["PQ_NONE"]);
    assert.equal(one.members[0]!.status, "note");
  });

  it("FA_MULTIPLE ignores function-call keys and ML-DSA keys", async (t) => {
    const keys = [ed(1), ed(2, RECENT, fc("r.testnet")), ed(3, RECENT, fc("r.testnet")), ml(4)];
    const { report } = await run(t, keys);
    assert.deepEqual(flagIds(report), ["PQ_PARTIAL"]);
  });

  it("4 ed + 1 ML-DSA FA key: FA_MANY counts ed25519 only; PQ_PARTIAL tags ed keys only", async (t) => {
    const { report } = await run(t, [...eds(4), ml(9)]);
    assert.deepEqual(flagIds(report), ["FA_MULTIPLE", "PQ_PARTIAL"]);
    assert.deepEqual(keyFlags(report), [...Array(4).fill(["FA_MULTIPLE", "PQ_PARTIAL"]), []]);
    assert.deepEqual(report.members[0]!.flags[1]!.evidence, { ml_dsa: 1, full_access_ed25519: 4 });
    assert.equal(report.members[0]!.pq_ready, false);
    assert.equal(report.members[0]!.counts.ml_dsa, 1);
  });

  it("a key with an unknown curve prefix is curve unknown: it counts as full access but not toward ed25519 rules", async (t) => {
    const { report } = await run(t, [ed(1), rawKey("secp256k1:S1", RECENT, FA)]);
    const m = report.members[0]!;
    assert.equal(m.keys[1]!.curve, "unknown");
    assert.equal(m.counts.full_access, 2);
    assert.deepEqual(flagIds(report), ["PQ_NONE"]);
  });

  it("an ML-DSA-only account is clean and pq_ready", async (t) => {
    const { report } = await run(t, [ml(1)]);
    assert.deepEqual(flagIds(report), []);
    assert.equal(report.members[0]!.status, "ok");
    assert.equal(report.members[0]!.pq_ready, true);
    assert.equal(report.summary.pq_ready, 1);
  });

  it("PQ_NONE: note, carries no key ids, also for function-call-only accounts", async (t) => {
    const { report } = await run(t, [ed(1, RECENT, fc("r.testnet"))]);
    assert.deepEqual(flagIds(report), ["PQ_NONE"]);
    assert.deepEqual(keyFlags(report), [[]]);
    assert.equal(report.members[0]!.flags[0]!.severity, "note");
    assert.equal(report.members[0]!.flags[0]!.public_key, undefined);
  });

  it("an existing account with zero keys: view_account follow-up, status ok, no PQ_NONE", async (t) => {
    const { report, calls } = await run(t, []);
    assert.deepEqual(
      calls.map((c) => c.params.request_type ?? c.method),
      ["block", "view_access_key_list", "view_account"],
    );
    assert.equal(report.members[0]!.status, "ok");
    assert.deepEqual(report.members[0]!.keys, []);
    assert.deepEqual(flagIds(report), []);
  });

  it("FA_OLD: age 730 days does not fire, 731 does (remainder fixture)", async (t) => {
    const blocksPerDay = 72_000;
    // elapsed 730 d + 1 block short of 731 d: floor(age) = 730
    const just = HEAD - (731 * blocksPerDay - 1);
    const old = HEAD - 731 * blocksPerDay;
    const a = (await run(t, [ed(1, nonceAt(just, 3))])).report.members[0]!;
    assert.equal(a.keys[0]!.age_days, 730);
    assert.deepEqual(a.flags.map((f) => f.rule_id), ["PQ_NONE"]);
    const b = (await run(t, [ed(1, nonceAt(old, 3))])).report.members[0]!;
    assert.equal(b.keys[0]!.age_days, 731);
    assert.deepEqual(b.flags.map((f) => f.rule_id), ["FA_OLD", "PQ_NONE"]);
    assert.deepEqual(b.flags[0]!.evidence, { age_days: 731 });
    assert.deepEqual(b.keys[0]!.flag_ids, ["FA_OLD"]);
  });

  it("FA_OLD never fires on a function-call key, even with unknown age", async (t) => {
    const { report } = await run(t, [ed(1, 77, fc("r.testnet")), ed(2, nonceAt(HEAD - 90_000_000, 9), fc("r.testnet"))]);
    assert.deepEqual(flagIds(report), ["PQ_NONE"]);
  });

  it("KEY_UNUSED fires on any key kind with use_count 0, not on 1", async (t) => {
    const keys = [
      ed(1, nonceAt(HEAD - 1000, 0)),
      ed(2, nonceAt(HEAD - 1000, 0), fc("r.testnet")),
      ed(3, nonceAt(HEAD - 1000, 1)),
    ];
    const { report } = await run(t, keys);
    assert.deepEqual(flagIds(report), ["FA_MULTIPLE", "KEY_UNUSED", "KEY_UNUSED", "PQ_NONE"]);
    assert.deepEqual(keyFlags(report), [["FA_MULTIPLE", "KEY_UNUSED"], ["KEY_UNUSED"], ["FA_MULTIPLE"]]);
    assert.equal(report.members[0]!.counts.unused, 2);
    assert.equal(report.summary.keys_unused, 2);
  });

  it("FA_BOT_LIKE: 999 uses no, 1000 yes, function-call key with 1000 no", async (t) => {
    const n = (u: number) => nonceAt(HEAD - 1000, u);
    assert.deepEqual(flagIds((await run(t, [ed(1, n(999))])).report), ["PQ_NONE"]);
    const hit = (await run(t, [ed(1, n(1000))])).report;
    assert.deepEqual(flagIds(hit), ["FA_BOT_LIKE", "PQ_NONE"]);
    assert.deepEqual(hit.members[0]!.flags[0]!.evidence, { use_count: 1000 });
    assert.deepEqual(flagIds((await run(t, [ed(1, n(1000), fc("r.testnet"))])).report), ["PQ_NONE"]);
  });
});

describe("S1-AC3: key age from the nonce", () => {
  const key = async (t: TestContext, nonce: number | string, id = ID) =>
    (await run(t, [ed(1, nonce)], {}, id)).report.members[0]!.keys[0]!;

  it("at the head: age 0, created at the head block", async (t) => {
    const k = await key(t, nonceAt(HEAD, 7));
    assert.deepEqual(k.created, { block_height: HEAD, at: iso(HEAD_TS_SEC), source: "nonce_estimate" });
    assert.equal(k.age_days, 0);
    assert.equal(k.use_count, 7);
    assert.equal(k.nonce, String(nonceAt(HEAD, 7)));
  });

  it("created.at is floored to whole seconds (1 block = 1.2 s)", async (t) => {
    const k = await key(t, nonceAt(HEAD - 1, 1));
    // 1793671210 - 1.2 = ...208.8 -> floor 208 (a rounding mutant gives 209)
    assert.equal(k.created.at, iso(HEAD_TS_SEC - 2));
  });

  it("one block above the head is unknown, and FA_OLD fires", async (t) => {
    const r = (await run(t, [ed(1, nonceAt(HEAD + 1, 4))])).report.members[0]!;
    assert.deepEqual(r.keys[0]!.created, { block_height: null, at: null, source: "unknown" });
    assert.equal(r.keys[0]!.age_days, null);
    assert.equal(r.keys[0]!.use_count, null);
    assert.deepEqual(r.flags.map((f) => f.rule_id), ["FA_OLD", "PQ_NONE"]);
    assert.deepEqual(r.flags[0]!.evidence, { age_days: null });
  });

  it("testnet genesis height is known, one below is unknown", async (t) => {
    const g = GENESIS_HEIGHT.testnet;
    assert.equal((await key(t, nonceAt(g, 2))).created.source, "nonce_estimate");
    assert.equal((await key(t, nonceAt(g - 1, 2))).created.source, "unknown");
  });

  it("mainnet uses the mainnet genesis (a .near id is scanned on the mainnet table)", async (t) => {
    const g = GENESIS_HEIGHT.mainnet;
    assert.ok(g < GENESIS_HEIGHT.testnet);
    assert.equal((await key(t, nonceAt(g, 2), "a.kd-demo.near")).created.source, "nonce_estimate");
    assert.equal((await key(t, nonceAt(g - 1, 2), "a.kd-demo.near")).created.source, "unknown");
    // a height between the two genesis values is unknown on testnet, known on mainnet
    assert.equal((await key(t, nonceAt(g + 5, 2))).created.source, "unknown");
  });

  it("small legacy counter (h = 0): unknown age but the use count survives; 0 uses is KEY_UNUSED", async (t) => {
    assert.equal((await key(t, 7)).use_count, 7);
    const zero = (await run(t, [ed(1, 0)])).report.members[0]!;
    assert.equal(zero.keys[0]!.use_count, 0);
    assert.deepEqual(zero.flags.map((f) => f.rule_id), ["FA_OLD", "KEY_UNUSED", "PQ_NONE"]);
  });

  it("a string nonce above 2^53 is accepted (unknown age); the same as a JSON number is a shape error", async (t) => {
    const big = "9007199254740993";
    const k = await key(t, big);
    assert.equal(k.created.source, "unknown");
    assert.equal(k.nonce, big);
    const raw = `{"jsonrpc":"2.0","id":"kd","result":{"keys":[{"public_key":"ed25519:E1","access_key":{"nonce":${big},"permission":"FullAccess"}}]}}`;
    installFetch(t, (req) => (req.method === "block" ? world({}) (req) : new Response(raw, { status: 200 })));
    await assert.rejects(scanAccount(ID), (e: any) => e.kd.code === "RPC_ERROR" && e.kd.retryable === true);
  });
});

describe("S1-AC6: summary and counts for one member", () => {
  it("high account: counts and summary sums", async (t) => {
    const keys = [...eds(5), ed(7, nonceAt(HEAD - 1000, 0), fc("r.testnet")), ml(8)];
    const { report } = await run(t, keys);
    const m = report.members[0]!;
    assert.deepEqual(m.counts, { full_access: 6, function_call: 1, ml_dsa: 1, unused: 1 });
    assert.deepEqual(report.summary, {
      status: "high",
      council_size: 0,
      members_scanned: 1,
      members_high: 1,
      members_cleanup: 0,
      members_ok: 0,
      pq_ready: 0,
      keys_total: 7,
      keys_full_access: 6,
      keys_unused: 1,
    });
    assert.deepEqual(report.dao_flags, []);
  });

  it("note-only account counts in members_ok; cleanup account in members_cleanup", async (t) => {
    const note = (await run(t, eds(1))).report.summary;
    assert.equal(note.status, "note");
    assert.equal(note.members_ok, 1);
    assert.equal(note.members_cleanup, 0);
    const cleanup = (await run(t, eds(2))).report.summary;
    assert.equal(cleanup.status, "cleanup");
    assert.equal(cleanup.members_cleanup, 1);
    assert.equal(cleanup.members_ok, 0);
  });
});

describe("S2-AC1: function-call key rules", () => {
  it("FC_UNLIMITED_ALLOWANCE: null fires, '0' does not", async (t) => {
    const hit = (await run(t, [ed(1, RECENT, fc("r.testnet", ["m"], null))])).report;
    assert.deepEqual(flagIds(hit), ["FC_UNLIMITED_ALLOWANCE", "PQ_NONE"]);
    assert.deepEqual(hit.members[0]!.flags[0]!.evidence, { allowance_yocto: null });
    assert.deepEqual(keyFlags(hit), [["FC_UNLIMITED_ALLOWANCE"]]);
    assert.deepEqual(flagIds((await run(t, [ed(1, RECENT, fc("r.testnet", ["m"], "0"))])).report), ["PQ_NONE"]);
  });

  it("FC_ANY_METHOD: empty method list fires, one method does not", async (t) => {
    const hit = (await run(t, [ed(1, RECENT, fc("r.testnet", []))])).report;
    assert.deepEqual(flagIds(hit), ["FC_ANY_METHOD", "PQ_NONE"]);
    assert.deepEqual(hit.members[0]!.flags[0]!.evidence, { method_names: [] });
    assert.deepEqual(flagIds((await run(t, [ed(1, RECENT, fc("r.testnet", ["a"]))])).report), ["PQ_NONE"]);
  });

  it("FC_ANY_METHOD text names the receiver only when it passes the account-id check", async (t) => {
    const good = (await run(t, [ed(1, RECENT, fc("r.testnet", []))])).report.members[0]!.flags[0]!;
    assert.match(good.messages.en.explain, /r\.testnet/);
    assert.match(good.messages.vi.explain, /r\.testnet/);
    const bad = (await run(t, [ed(1, RECENT, fc("Bad<b>ID", []))])).report;
    const text = JSON.stringify(bad.members[0]!.flags[0]!.messages);
    assert.doesNotMatch(text, /Bad/);
    assert.match(bad.members[0]!.flags[0]!.messages.en.explain, /its receiver contract/);
  });

  it("FC_DEAD_RECEIVER fires on a missing receiver only", async (t) => {
    const keys = [ed(1, RECENT, fc("gone.testnet")), ed(2, RECENT, fc("here.testnet"))];
    const { report } = await run(t, keys, { missing: ["gone.testnet"] });
    assert.deepEqual(flagIds(report), ["FC_DEAD_RECEIVER", "PQ_NONE"]);
    assert.deepEqual(keyFlags(report), [["FC_DEAD_RECEIVER"], []]);
    assert.deepEqual(report.members[0]!.flags[0]!.evidence, { receiver_id: "gone.testnet" });
    assert.equal(report.members[0]!.flags[0]!.public_key, "ed25519:E1");
  });

  it("flag order: severity, then rule order, then key order", async (t) => {
    const keys = [
      ed(1, nonceAt(HEAD - 1000, 0), fc("r.testnet", [], null)),
      ed(2, nonceAt(HEAD - 1000, 0)),
    ];
    const { report } = await run(t, keys);
    assert.deepEqual(
      report.members[0]!.flags.map((f) => [f.rule_id, f.public_key ?? null]),
      [
        ["KEY_UNUSED", "ed25519:E1"],
        ["KEY_UNUSED", "ed25519:E2"],
        ["FC_UNLIMITED_ALLOWANCE", "ed25519:E1"],
        ["FC_ANY_METHOD", "ed25519:E1"],
        ["PQ_NONE", null],
      ],
    );
    assert.deepEqual(keyFlags(report)[0], ["KEY_UNUSED", "FC_UNLIMITED_ALLOWANCE", "FC_ANY_METHOD"]);
  });
});
