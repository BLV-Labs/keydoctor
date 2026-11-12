import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { TOOLS } from "../src/mcp/server.ts";
import { MAX_UNWATCHED_BASELINES } from "../src/store/snapshots.ts";
import { OVERFLOW_KEY, checkRate, clientKey } from "../src/mcp/rate-limit.ts";
import { testD1, type TestD1 } from "./support/d1.ts";
import { DAO, addKey, bytes, fixture, installChain } from "./support/rpc.ts";

const ctx = { waitUntil: () => {} };

function setup(t: TestContext) {
  const db = testD1();
  const env: Env = { DB: db };
  const chain = installChain(t);
  return { db, env, chain };
}

let nextId = 1;
async function rpc(env: Env, method: string, params: unknown = {}) {
  const res = await worker.fetch(
    new Request("https://kd.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    env,
    ctx,
  );
  return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as any) };
}
const call = async (env: Env, name: string, args: unknown) => (await rpc(env, "tools/call", { name, arguments: args })).body.result;
const snapshots = (db: TestD1) => (db.raw.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n;

describe("MCP rate limit", () => {
  const callFrom = (env: Env, ip: string) =>
    worker.fetch(
      new Request("https://kd.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }),
      }),
      env,
      ctx,
    );

  it("answers 429 RATE_LIMITED past the per-IP limit, per IP, and never limits tools/list", async () => {
    const env: Env = { DB: testD1(), MCP_RATE_LIMIT_PER_MIN: "3" };
    for (let i = 0; i < 3; i++) assert.notEqual((await callFrom(env, "203.0.113.1")).status, 429);
    const over = await callFrom(env, "203.0.113.1");
    assert.equal(over.status, 429);
    assert.equal(((await over.json()) as any).code, "RATE_LIMITED");
    assert.ok(Number(over.headers.get("retry-after")) > 0);
    assert.notEqual((await callFrom(env, "203.0.113.2")).status, 429);
    assert.equal((await rpc(env, "tools/list")).status, 200);
  });
});

// Red-team M6: an IPv6 user rotates freely inside a /64, so keying on the exact address gave each call a fresh budget.
describe("rate-limit keys", () => {
  it("IPv6 is keyed on its /64, IPv4 on the exact address", () => {
    assert.equal(clientKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
    assert.equal(clientKey("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
    assert.equal(clientKey("2001:db8::7"), "2001:db8:0:0::/64");
    assert.equal(clientKey("::1"), "0:0:0:0::/64");
    assert.notEqual(clientKey("2001:db8:1:3::1"), clientKey("2001:db8:1:2::1"));
    assert.equal(clientKey("203.0.113.1"), "203.0.113.1");
  });

  it("the MCP limit holds across addresses in one /64", async () => {
    const env: Env = { DB: testD1(), MCP_RATE_LIMIT_PER_MIN: "2" };
    const from = (ip: string) =>
      worker.fetch(
        new Request("https://kd.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }),
        }),
        env,
        ctx,
      );
    assert.notEqual((await from("2001:db8:9:9::1")).status, 429);
    assert.notEqual((await from("2001:db8:9:9::2")).status, 429);
    assert.equal((await from("2001:db8:9:9::3")).status, 429);
  });

  it("a flood of fresh keys shares one overflow bucket instead of growing the map", () => {
    // An old window, so these entries are expired for every other test that runs later in real time.
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 1000; i++) checkRate(`flood-${i}`, 1, t0);
    checkRate("flood-new-a", 1, t0 + 1);
    assert.ok(checkRate("flood-new-b", 1, t0 + 2) > 0, "a second new key lands in the same, already used, bucket");
    assert.ok(checkRate(OVERFLOW_KEY, 1, t0 + 3) > 0);
    assert.equal(checkRate("flood-new-c", 1, t0 + 120_000), 0, "once the old window passes, expired keys are pruned");
  });
});

describe("GĐ3 Worker: routes and auth", () => {
  it("GET / answers ok without auth", async () => {
    const res = await worker.fetch(new Request("https://kd.test/"), { DB: testD1() }, ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("/mcp needs no Authorization header: the token was dropped so judges and agents can call it directly", async (t) => {
    const { env } = setup(t);
    const list = await rpc(env, "tools/list");
    assert.equal(list.status, 200);
    assert.equal(list.body.result.tools.length, 7);
  });

  it("unknown paths are 404", async () => {
    const res = await worker.fetch(new Request("https://kd.test/nope", { method: "POST" }), { DB: testD1() }, ctx);
    assert.equal(res.status, 404);
  });
});

describe("GĐ3 MCP protocol", () => {
  it("initialize, notifications, ping and tools/list", async (t) => {
    const { env } = setup(t);
    const init = await rpc(env, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal(init.body.result.serverInfo.name, "key-doctor");
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    const old = await rpc(env, "initialize", { protocolVersion: "1999-01-01" });
    assert.equal(old.body.result.protocolVersion, "2025-06-18");

    const note = await worker.fetch(
      new Request("https://kd.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      env,
      ctx,
    );
    assert.equal(note.status, 202);
    assert.deepEqual((await rpc(env, "ping")).body.result, {});

    const list = await rpc(env, "tools/list");
    assert.deepEqual(list.body.result.tools.map((x: any) => x.name), ["diagnose", "compare", "list_keys", "list_proposals", "watch", "preflight", "yield_suggestions"]);
    assert.match(TOOLS[1]!.description, /later calls never move it/);
    assert.equal((await rpc(env, "nope")).body.error.code, -32601);
  });

  it("rejects bad JSON-RPC and GET", async (t) => {
    const { env } = setup(t);
    const bad = await worker.fetch(new Request("https://kd.test/mcp", { method: "POST", body: "[1,2]" }), env, ctx);
    assert.equal(bad.status, 400);
    const get = await worker.fetch(new Request("https://kd.test/mcp", {}), env, ctx);
    assert.equal(get.status, 405);
  });
});

describe("preflight (agent pre-flight)", () => {
  it("returns kd.preflight.v1: block on the demo account with a full-access key added 3 h ago, never touches D1", async (t) => {
    const { env, db } = setup(t);
    const r = await call(env, "preflight", { target: "a.kd-demo.testnet" });
    assert.equal(r.isError, undefined);
    const g = r.structuredContent;
    assert.equal(g.schema_version, "kd.preflight.v1");
    assert.equal(g.verdict, "block");
    assert.ok(g.reasons.some((x: any) => x.code === "FA_RECENT"));
    assert.deepEqual(JSON.parse(r.content[0].text), g);
    assert.deepEqual(db.log, []);
  });

  it("review for cleanup flags, allow for a clean account", async (t) => {
    const { env } = setup(t);
    assert.equal((await call(env, "preflight", { target: "b.kd-demo.testnet" })).structuredContent.verdict, "review");
    const c = (await call(env, "preflight", { target: "c.kd-demo.testnet" })).structuredContent;
    assert.equal(c.verdict, "allow");
    assert.deepEqual(c.reasons, []);
  });

  it("an RPC failure is verdict review, not isError: an agent that skips errors must not pay from an unread account", async (t) => {
    const { env, chain } = setup(t);
    chain.keys["x.kd-demo.testnet"] = { jsonrpc: "2.0", id: "kd", error: { name: "HANDLER_ERROR", cause: { name: "INTERNAL_ERROR" } } };
    const r = await call(env, "preflight", { target: "x.kd-demo.testnet" });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.verdict, "review");
    assert.equal(r.structuredContent.account.error, "RPC_ERROR");
    assert.equal(r.structuredContent.block_height, null);
    // A missing account is still an error: there is nothing to pay from.
    assert.equal((await call(env, "preflight", { target: "nobody.kd-demo.testnet" })).structuredContent.code, "NOT_FOUND");
  });

  it("refuses a DAO, extra arguments and bad names with kd.error.v1; the tool is marked read-only", async (t) => {
    const { env } = setup(t);
    const dao = await call(env, "preflight", { target: DAO });
    assert.equal(dao.isError, true);
    assert.equal(dao.structuredContent.code, "INVALID_TARGET");
    assert.match(dao.structuredContent.message.en, /use diagnose/);
    assert.equal((await call(env, "preflight", { target: "b.kd-demo.testnet", counterparty: "c.kd-demo.testnet" })).isError, true);
    assert.equal((await call(env, "preflight", { target: "not a name!" })).structuredContent.code, "INVALID_TARGET");
    assert.equal(TOOLS.find((x) => x.name === "preflight")!.annotations.readOnlyHint, true);
  });
});

describe("GĐ3 diagnose", () => {
  it("returns kd.report_summary.v1 by default and never touches D1", async (t) => {
    const { env, db } = setup(t);
    const r = await call(env, "diagnose", { target: DAO });
    assert.equal(r.isError, undefined);
    const s = r.structuredContent;
    assert.equal(s.schema_version, "kd.report_summary.v1");
    assert.equal(s.summary.status, "high");
    assert.deepEqual(s.members.map((m: any) => m.account_id), ["a.kd-demo.testnet", "b.kd-demo.testnet", "c.kd-demo.testnet"]);
    assert.ok(s.members.every((m: any) => !("keys" in m)));
    assert.deepEqual(JSON.parse(r.content[0].text), s);
    assert.deepEqual(db.log, []);
  });

  it("detail=full returns kd.report.v1; an account target works too", async (t) => {
    const { env } = setup(t);
    const full = (await call(env, "diagnose", { target: DAO, detail: "full" })).structuredContent;
    assert.equal(full.schema_version, "kd.report.v1");
    assert.ok(full.members[0].keys.length > 0);
    const acc = (await call(env, "diagnose", { target: "b.kd-demo.testnet" })).structuredContent;
    assert.equal(acc.target.type, "account");
  });

  it("errors come back as isError with kd.error.v1", async (t) => {
    const { env } = setup(t);
    const invalid = await call(env, "diagnose", { target: "not a name!" });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.code, "INVALID_TARGET");
    const missing = await call(env, "diagnose", { target: "nobody.kd-demo.testnet" });
    assert.equal(missing.structuredContent.code, "NOT_FOUND");
    const conflict = await call(env, "diagnose", { target: DAO, network: "mainnet" });
    assert.equal(conflict.structuredContent.code, "INVALID_TARGET");
    const extra = await call(env, "diagnose", { target: DAO, sneaky: 1 });
    assert.equal(extra.isError, true);
    assert.equal((await rpc(env, "tools/call", { name: "nope", arguments: {} })).body.error.code, -32602);
  });
});

describe("GĐ3 compare and the baseline", () => {
  it("the first call stores the baseline and reports no changes", async (t) => {
    const { env, db } = setup(t);
    const d = (await call(env, "compare", { target: DAO })).structuredContent;
    assert.equal(d.schema_version, "kd.diff.v1");
    assert.equal(d.is_baseline, true);
    assert.equal(d.baseline_updated, true);
    assert.deepEqual(d.changes, []);
    assert.equal(snapshots(db), 1);
  });

  it("later calls do not move the baseline (UC3 done-when)", async (t) => {
    const { env, db, chain } = setup(t);
    await call(env, "compare", { target: DAO });
    addKey(chain, "b.kd-demo.testnet", "ed25519:NewKeyAddedToB1111111111111111111111111111");
    const first = (await call(env, "compare", { target: DAO })).structuredContent;
    const second = (await call(env, "compare", { target: DAO })).structuredContent;
    assert.equal(first.baseline_updated, false);
    assert.equal(snapshots(db), 1);
    assert.deepEqual(second.changes, first.changes);
    assert.equal(first.changes[0].type, "key_added");
    assert.equal(first.changes[0].severity, "high");
    assert.equal(first.changes[0].account_id, "b.kd-demo.testnet");
  });

  it("an anonymous caller cannot move the baseline to hide a new key from the daily alert (red-team H1)", async (t) => {
    // /mcp has no auth. If compare could move the baseline, whoever added a key could fold it into the baseline
    // before its next daily check and the daily job would see no change and send no "key added" alert.
    const { env, db, chain } = setup(t);
    await call(env, "compare", { target: DAO });
    addKey(chain, "b.kd-demo.testnet", "ed25519:NewKeyAddedToB1111111111111111111111111111");
    const r = await call(env, "compare", { target: DAO, update_baseline: true });
    assert.equal(r.isError, true);
    assert.equal(snapshots(db), 1);
    const after = (await call(env, "compare", { target: DAO })).structuredContent;
    assert.equal(after.changes[0].type, "key_added", "the new key still shows against the old baseline");
  });
});

describe("compare baselines are capped (red-team M9)", () => {
  it("past MAX_UNWATCHED_BASELINES unwatched targets, a first compare answers but stores nothing; watched targets do not count", async (t) => {
    // /mcp is open and the first compare of a target stores a baseline, so a loop over made-up names would fill D1.
    const { env, db } = setup(t);
    const ins = db.raw.prepare("INSERT INTO snapshots (target, network, generated_at, block_height, report_json) VALUES (?, 'testnet', '2026-11-01T00:00:00Z', 1, '{}')");
    for (let i = 0; i < MAX_UNWATCHED_BASELINES; i++) ins.run(`x${i}.kd-demo.testnet`);
    const full = (await call(env, "compare", { target: DAO })).structuredContent;
    assert.equal(full.is_baseline, true);
    assert.equal(full.baseline_updated, false);
    assert.equal(snapshots(db), MAX_UNWATCHED_BASELINES, "nothing stored");
    // A chat watching one of them frees a slot: watched baselines are not counted.
    db.raw.prepare("INSERT INTO subscriptions (target, network, target_type, chat_id, chat_type, created_at) VALUES ('x0.kd-demo.testnet', 'testnet', 'account', '1', 'private', '2026-11-01T00:00:00Z')").run();
    assert.equal((await call(env, "compare", { target: DAO })).structuredContent.baseline_updated, true);
    assert.equal(snapshots(db), MAX_UNWATCHED_BASELINES + 1);
  });
});

describe("MCP list_keys (the dashboard key table)", () => {
  it("returns one row per key with what it is approved for, age, uses and the flags raised on it; never touches D1", async (t) => {
    const { env, db } = setup(t);
    const r = (await call(env, "list_keys", { target: DAO })).structuredContent;
    assert.equal(r.target.id, DAO);
    assert.equal(r.total, r.keys.length);
    assert.deepEqual([...new Set(r.keys.map((k: any) => k.account_id))].sort(), ["a.kd-demo.testnet", "b.kd-demo.testnet", "c.kd-demo.testnet"]);
    const app = r.keys.find((k: any) => k.permission.type === "function_call" && k.account_id === "b.kd-demo.testnet");
    assert.equal(app.permission.receiver_id, "game.kd-demo.testnet");
    assert.ok("age_days" in app && "use_count" in app && Array.isArray(app.roles));
    assert.ok(r.keys.every((k: any) => !("flag_ids" in k)));
    assert.ok(r.keys.some((k: any) => k.flags.length > 0 && k.flags[0].messages.en.title));
    assert.deepEqual(db.log, []);
  });

  it("filters by member, permission and flagged_only", async (t) => {
    const { env } = setup(t);
    const onlyB = (await call(env, "list_keys", { target: DAO, account_id: "b.kd-demo.testnet" })).structuredContent;
    assert.ok(onlyB.keys.length > 0 && onlyB.keys.every((k: any) => k.account_id === "b.kd-demo.testnet"));
    const fc = (await call(env, "list_keys", { target: DAO, permission: "function_call" })).structuredContent;
    assert.ok(fc.keys.length > 0 && fc.keys.every((k: any) => k.permission.type === "function_call"));
    const flagged = (await call(env, "list_keys", { target: DAO, flagged_only: true })).structuredContent;
    const all = (await call(env, "list_keys", { target: DAO })).structuredContent;
    assert.ok(flagged.total > 0 && flagged.total < all.total);
    assert.ok(flagged.keys.every((k: any) => k.flags.length > 0));
  });

  it("rejects bad arguments", async (t) => {
    const { env } = setup(t);
    for (const args of [{ permission: "root" }, { flagged_only: "yes" }, { account_id: 5 }, { limit: 3 }]) {
      const r = await call(env, "list_keys", { target: DAO, ...args });
      assert.equal(r.isError, true, JSON.stringify(args));
    }
  });
});

describe("MCP list_proposals", () => {
  function demo(chain: ReturnType<typeof setup>["chain"]) {
    const proposals: Record<number, unknown> = {
      0: { ...fixture<object>("sputnik/get_proposal.2.transfer.json"), id: 0 },
      1: { ...fixture<object>("sputnik/get_proposal.3.add_member.json"), id: 1 },
      2: { ...fixture<object>("sputnik/get_proposal.2.transfer.json"), id: 2 },
    };
    chain.views.get_last_proposal_id = () => bytes(3);
    chain.views.get_proposal = (args: { id: number }) => bytes(proposals[args.id]);
  }

  it("lists newest first with votes and pending voters, and pages with limit/offset", async (t) => {
    const { env, chain, db } = setup(t);
    demo(chain);
    const r = (await call(env, "list_proposals", { target: DAO })).structuredContent;
    assert.equal(r.total, 3);
    assert.deepEqual(r.proposals.map((p: any) => p.id), [2, 1, 0]);
    assert.ok(r.proposals.every((p: any) => typeof p.status === "string" && Array.isArray(p.pending_voters)));
    const page = (await call(env, "list_proposals", { target: DAO, limit: 1, offset: 1 })).structuredContent;
    assert.deepEqual(page.proposals.map((p: any) => p.id), [1]);
    assert.deepEqual(db.log, []);
  });

  it("rejects out-of-range paging and a non-DAO target comes back as an error", async (t) => {
    const { env } = setup(t);
    for (const args of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { limit: 1.5 }]) {
      assert.equal((await call(env, "list_proposals", { target: DAO, ...args })).isError, true, JSON.stringify(args));
    }
    const account = await call(env, "list_proposals", { target: "b.kd-demo.testnet" });
    assert.equal(account.isError, true);
    assert.equal(account.structuredContent.schema_version, "kd.error.v1");
  });
});
