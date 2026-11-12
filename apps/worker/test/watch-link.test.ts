import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { handleUpdate, parseCommand } from "../src/telegram/commands.ts";
import { MAX_LIVE_PENDING, MAX_LIVE_PENDING_PER_CLIENT, isCode, newCode } from "../src/watch-link.ts";
import { WATCH_LINK_PER_MIN } from "../src/index.ts";
import { testD1, type TestD1 } from "./support/d1.ts";
import { DAO, installChain, type Chain } from "./support/rpc.ts";

const ORIGIN = "https://dash.example";
const ctx = { waitUntil: () => {} };

function setup(t: TestContext) {
  const db = testD1();
  const chain = installChain(t);
  const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: "1:x", DASHBOARD_ORIGIN: ORIGIN, PENDING_SUB_TTL_MINUTES: "30" };
  return { db, chain, env };
}
const rows = (db: TestD1, sql: string) => (db.raw.prepare(sql).all() as any[]).map((r) => ({ ...r }));

function post(env: Env, body: unknown, origin: string | null = ORIGIN, method = "POST", ip?: string) {
  return worker.fetch(
    new Request("https://kd.test/api/watch-link", {
      method,
      headers: { "content-type": "application/json", ...(origin !== null && { origin }), ...(ip !== undefined && { "cf-connecting-ip": ip }) },
      ...(method === "POST" && { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
}

async function start(env: Env, chain: Chain, code: string, chat = 9, type = "private") {
  await handleUpdate({ message: { text: `/start ${code}`, chat: { id: chat, type }, from: { language_code: "en" } } }, env);
  return chain.telegram.filter((x) => x.method === "sendMessage").at(-1)?.body.text as string;
}

describe("GĐ12 watch links", () => {
  it("codes are 16 unbiased alphanumerics", () => {
    const codes = new Set(Array.from({ length: 200 }, newCode));
    assert.equal(codes.size, 200);
    for (const c of codes) assert.ok(isCode(c), c);
    assert.equal(isCode("short"), false);
  });

  it("POST /api/watch-link answers only DASHBOARD_ORIGIN, with CORS", async (t) => {
    const { env, db } = setup(t);
    assert.equal((await post(env, { target: DAO }, "https://evil.example")).status, 403);
    assert.equal((await post(env, { target: DAO }, null)).status, 403);
    assert.equal((await post({ ...env, DASHBOARD_ORIGIN: "" }, { target: DAO }, "")).status, 403);
    const pre = await post(env, null, ORIGIN, "OPTIONS");
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
    const res = await post(env, { target: DAO });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    const link = (await res.json()) as any;
    assert.equal(link.schema_version, "kd.watch_link.v1");
    assert.equal(link.target, DAO);
    assert.match(link.link_private, /^https:\/\/t\.me\/KeyDoctorOnCallBot\?start=[A-Za-z0-9]{16}$/);
    assert.equal(link.link_group, link.link_private.replace("?start=", "?startgroup="));
    assert.match(link.expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(rows(db, "SELECT * FROM pending_subscriptions").length, 1);
    assert.equal(rows(db, "SELECT * FROM subscriptions").length, 0, "nothing is subscribed until the link is opened");
    assert.equal((await post(env, { target: "Bad Name" })).status, 400);
    assert.equal((await post(env, { target: 5 })).status, 400);
  });

  it("refuses new codes past the live cap", async (t) => {
    const { env, db } = setup(t);
    const far = new Date(Date.now() + 3_600_000).toISOString();
    const insert = db.raw.prepare("INSERT INTO pending_subscriptions (token, target, network, created_at, expires_at) VALUES (?, 'x.testnet', 'testnet', 'x', ?)");
    for (let i = 0; i < MAX_LIVE_PENDING; i++) insert.run(`code${i}`, far);
    const res = await post(env, { target: DAO });
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as any).code, "RATE_LIMITED");
  });

  // Red-team M5: Origin is a header curl can set, so the global cap alone let one script block every watch link for 30 min.
  it("one client cannot fill the live cap: per-client cap, then per-minute limit; others still get links", async (t) => {
    const { env, db } = setup(t);
    const far = new Date(Date.now() + 3_600_000).toISOString();
    const res0 = await post(env, { target: DAO }, ORIGIN, "POST", "2001:db8:1:2::1");
    assert.equal(res0.status, 200);
    const client = rows(db, "SELECT client FROM pending_subscriptions")[0].client;
    assert.match(client, /^[0-9a-f]{16}$/, "a hash is stored, never the address");
    const insert = db.raw.prepare("INSERT INTO pending_subscriptions (token, target, network, created_at, expires_at, client) VALUES (?, 'x.testnet', 'testnet', 'x', ?, ?)");
    for (let i = 1; i < MAX_LIVE_PENDING_PER_CLIENT; i++) insert.run(`c${i}`, far, client);
    // Same /64, another address: still the same client.
    const capped = await post(env, { target: DAO }, ORIGIN, "POST", "2001:db8:1:2:ffff::9");
    assert.equal(capped.status, 429);
    assert.equal(((await capped.json()) as any).code, "RATE_LIMITED");
    assert.equal((await post(env, { target: DAO }, ORIGIN, "POST", "198.51.100.7")).status, 200, "another client is not blocked");
    let limited = 0;
    for (let i = 0; i < WATCH_LINK_PER_MIN + 1; i++) if ((await post(env, { target: "Bad Name" }, ORIGIN, "POST", "198.51.100.8")).status === 429) limited++;
    assert.equal(limited, 1, "past WATCH_LINK_PER_MIN calls a minute the route answers 429 before reading the body");
  });

  it("/start <code> in a group subscribes it like /watch, once; the code works one time", async (t) => {
    const { env, db, chain } = setup(t);
    const link = (await (await post(env, { target: DAO })).json()) as any;
    const code = link.link_group.split("=")[1];
    assert.deepEqual(parseCommand(`/start@KeyDoctorOnCallBot ${code}`, true), { name: "start", code });
    const text = await start(env, chain, code, -77, "supergroup");
    assert.match(text, /This chat now watches kd-demo\.sputnik-dao\.testnet/);
    assert.deepEqual(rows(db, "SELECT target, chat_id, target_type FROM subscriptions"), [{ target: DAO, chat_id: "-77", target_type: "dao" }]);
    assert.equal(rows(db, "SELECT * FROM proposal_state").length, 1);
    assert.equal(rows(db, "SELECT * FROM pending_subscriptions").length, 0);
    assert.match(await start(env, chain, code, -77, "supergroup"), /expired or was already used/);
  });

  it("an expired code is refused and removed", async (t) => {
    const { env, db, chain } = setup(t);
    db.raw.prepare("INSERT INTO pending_subscriptions (token, target, network, created_at, expires_at) VALUES ('AAAAAAAAAAAAAAAA', ?, 'testnet', 'x', '2020-01-01T00:00:00Z')").run(DAO);
    assert.match(await start(env, chain, "AAAAAAAAAAAAAAAA"), /expired/);
    assert.equal(rows(db, "SELECT * FROM pending_subscriptions").length, 0);
    assert.equal(rows(db, "SELECT * FROM subscriptions").length, 0);
  });

  it("plain /start and a malformed code show help", () => {
    assert.deepEqual(parseCommand("/start", false), { name: "help" });
    assert.deepEqual(parseCommand("/start ../etc", false), { name: "help" });
  });

  it("MCP watch returns the same kd.watch_link.v1", async (t) => {
    const { env, db } = setup(t);
    const res = await worker.fetch(
      new Request("https://kd.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer m", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "watch", arguments: { target: "b.kd-demo.testnet" } } }),
      }),
      env,
      ctx,
    );
    const out = ((await res.json()) as any).result;
    assert.equal(out.structuredContent.schema_version, "kd.watch_link.v1");
    assert.equal(out.structuredContent.target, "b.kd-demo.testnet");
    assert.equal(rows(db, "SELECT * FROM pending_subscriptions").length, 1);
  });
});
