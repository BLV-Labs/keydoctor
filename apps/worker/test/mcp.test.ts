import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { TOOLS } from "../src/mcp/server.ts";
import { testD1, type TestD1 } from "./support/d1.ts";
import { DAO, addKey, installChain } from "./support/rpc.ts";

const TOKEN = "test-mcp-token";
const ctx = { waitUntil: () => {} };

function setup(t: TestContext) {
  const db = testD1();
  const env: Env = { DB: db, MCP_TOKEN: TOKEN };
  const chain = installChain(t);
  return { db, env, chain };
}

let nextId = 1;
async function rpc(env: Env, method: string, params: unknown = {}, token: string | null = TOKEN) {
  const res = await worker.fetch(
    new Request("https://kd.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token !== null && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    env,
    ctx,
  );
  return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as any) };
}
const call = async (env: Env, name: string, args: unknown) => (await rpc(env, "tools/call", { name, arguments: args })).body.result;
const snapshots = (db: TestD1) => (db.raw.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n;

describe("GĐ3 Worker: routes and auth", () => {
  it("GET / answers ok without auth", async () => {
    const res = await worker.fetch(new Request("https://kd.test/"), { DB: testD1() }, ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("/mcp rejects a missing, wrong or unconfigured token with kd.error.v1 UNAUTHORIZED before any work", async (t) => {
    const { env, chain } = setup(t);
    for (const token of [null, "wrong", ""]) {
      const r = await rpc(env, "tools/call", { name: "diagnose", arguments: { target: DAO } }, token);
      assert.equal(r.status, 401);
      assert.equal(r.body.code, "UNAUTHORIZED");
    }
    const noSecret = await rpc({ ...env, MCP_TOKEN: "" }, "tools/list", {}, "");
    assert.equal(noSecret.status, 401);
    assert.equal(chain.calls.length, 0);
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
      new Request("https://kd.test/mcp", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      env,
      ctx,
    );
    assert.equal(note.status, 202);
    assert.deepEqual((await rpc(env, "ping")).body.result, {});

    const list = await rpc(env, "tools/list");
    assert.deepEqual(list.body.result.tools.map((x: any) => x.name), ["diagnose", "compare"]);
    assert.match(TOOLS[1]!.description, /Only set update_baseline=true when explicitly asked; by default the baseline does not move\./);
    assert.equal((await rpc(env, "nope")).body.error.code, -32601);
  });

  it("rejects bad JSON-RPC and GET", async (t) => {
    const { env } = setup(t);
    const bad = await worker.fetch(new Request("https://kd.test/mcp", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "[1,2]" }), env, ctx);
    assert.equal(bad.status, 400);
    const get = await worker.fetch(new Request("https://kd.test/mcp", { headers: { authorization: `Bearer ${TOKEN}` } }), env, ctx);
    assert.equal(get.status, 405);
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
    assert.equal((await rpc(env, "tools/call", { name: "watch", arguments: {} })).body.error.code, -32602);
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

  it("later calls do not move the baseline unless update_baseline is true (UC3 done-when)", async (t) => {
    const { env, db, chain } = setup(t);
    await call(env, "compare", { target: DAO });
    addKey(chain, "b.kd-demo.testnet", "ed25519:NewKeyAddedToB1111111111111111111111111111");
    const first = (await call(env, "compare", { target: DAO })).structuredContent;
    const second = (await call(env, "compare", { target: DAO, update_baseline: false })).structuredContent;
    assert.equal(first.baseline_updated, false);
    assert.equal(snapshots(db), 1);
    assert.deepEqual(second.changes, first.changes);
    assert.equal(first.changes[0].type, "key_added");
    assert.equal(first.changes[0].severity, "high");
    assert.equal(first.changes[0].account_id, "b.kd-demo.testnet");

    const moved = (await call(env, "compare", { target: DAO, update_baseline: true })).structuredContent;
    assert.equal(moved.baseline_updated, true);
    const after = (await call(env, "compare", { target: DAO })).structuredContent;
    assert.deepEqual(after.changes, []);
  });

  it("repeated update_baseline keeps at most 7 snapshots", async (t) => {
    const { env, db } = setup(t);
    await call(env, "compare", { target: DAO });
    for (let i = 0; i < 9; i++) {
      db.raw.prepare("INSERT INTO snapshots VALUES (?, 'testnet', ?, ?, '{}')").run(DAO, `2026-10-0${i}T00:00:00Z`, i);
    }
    const r = await call(env, "compare", { target: DAO, update_baseline: true });
    assert.equal(r.isError, undefined);
    assert.equal(snapshots(db), 7);
  });

  it("validates update_baseline", async (t) => {
    const { env } = setup(t);
    const r = await call(env, "compare", { target: DAO, update_baseline: "yes" });
    assert.equal(r.isError, true);
  });
});
