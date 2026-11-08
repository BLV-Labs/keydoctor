// YD3: the yield surfaces. /yield and MCP yield_suggestions read only; /yield_watch opts a chat in; the job pushes
// to opted-in chats only when the top suggestion changes or its APR moves 0.5pp, sending first and recording after.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import worker, { YIELD_CRON } from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { handleUpdate } from "../src/telegram/commands.ts";
import { testD1, type TestD1 } from "./support/d1.ts";
import { DAO, bytes, fixture, installChain, type Chain } from "./support/rpc.ts";
// Mainnet protocol captures stay out of fixtures/ (testnet names only), so the library keeps them with its tests.
import { MAINNET_API, MAINNET_ASSETS } from "../../../packages/key-doctor/test/yield-data.ts";

const USDC_T = "usdc.fakes.testnet";
const TOP = `rhea-lend:${USDC_T}:supply`;
const RUN_TOKEN = "run-token";
/** supply_apr of the test USDC in fixtures/yield/rhea-lend.assets.json. */
const FIXTURE_APR = 0.10530425026152265;
const ctx = { waitUntil: () => {} };

/** Every test gets its own chat ids: the per-chat rate limiter is in memory and shared across tests. */
let nextChat = -9000;
const newChat = () => nextChat--;

interface YieldChain extends Chain {
  /** Testnet supply_apr of the test USDC on Rhea Lend (fixture: 0.1053, about 10.5%). */
  setApr(apr: string): void;
}

/** The demo DAO holds 20 test USDC with 3.5 locked by open transfers 1 and 4, so 16.5 is free to supply. */
function installYieldChain(t: TestContext): YieldChain {
  const chain = installChain(t) as YieldChain;
  const testnet = fixture<any[]>("yield/rhea-lend.assets.json");
  chain.setApr = (apr) => {
    testnet.find((a) => a.token_id === USDC_T).supply_apr = apr;
  };
  chain.views.get_last_proposal_id = () => bytes(5);
  chain.views.get_proposals = () => bytes(fixture("yield/get_proposals.vault.json"));
  chain.views.ft_balance_of = (_args, accountId) => (accountId === USDC_T ? bytes("20000000") : bytes("0"));
  chain.views.get_assets_paged_detailed = (_args, accountId) => bytes(accountId.endsWith(".testnet") ? testnet : MAINNET_ASSETS);
  chain.get = () => new Response(JSON.stringify(MAINNET_API), { status: 200 });
  return chain;
}

function setup(t: TestContext, extra: Partial<Env> = {}) {
  const db = testD1();
  const chain = installYieldChain(t);
  const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: "1:x", RUN_CHECK_TOKEN: RUN_TOKEN, ALERT_LANG: "en", ...extra };
  return { db, chain, env };
}

const say = (env: Env, text: string, chat: number, type = "group") =>
  handleUpdate({ message: { text, chat: { id: chat, type }, from: { language_code: "en" } } }, env);
const sends = (chain: Chain) => chain.telegram.filter((x) => x.method === "sendMessage");
const lastText = (chain: Chain): string => sends(chain).at(-1)?.body.text ?? "";
const rows = (db: TestD1, sql: string) => db.raw.prepare(sql).all().map((r) => ({ ...r })) as any[];
const writes = (db: TestD1) => db.log.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q));
const runJob = async (env: Env) => {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron: YIELD_CRON, scheduledTime: 0 }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
};

describe("YD3 /yield", () => {
  it("shows the suggestion capped at the free balance, with the test-data and not-advice notes, and touches no D1", async (t) => {
    const { env, chain, db } = setup(t);
    await say(env, `/yield ${DAO}`, newChat());
    const text = lastText(chain);
    assert.match(text, /^Key Doctor On Call\n/);
    assert.match(text, new RegExp(`Yield for ${DAO} \\(testnet\\)`));
    // 20 held, 3.5 promised to open transfers: suggesting the full 20 would bounce a payroll transfer.
    assert.match(text, /USDC \(test\): 20\.00, free 16\.50 \(2 open transfer proposals\)/);
    assert.match(text, /Supply USDC \(test\) on Rhea Lend: 10\.53% APR, up to 16\.50/);
    assert.match(text, /not financial advice/);
    assert.match(text, /Mainnet reference/);
    assert.match(text, new RegExp(`/yield_watch ${DAO}`));
    assert.equal(db.log.length, 0, "a read-only command must not read or write D1");
  });

  it("refuses an account: there is no treasury to put to work", async (t) => {
    const { env, chain, db } = setup(t);
    await say(env, "/yield a.kd-demo.testnet", newChat());
    assert.doesNotMatch(lastText(chain), /Yield for/);
    assert.equal(writes(db).length, 0);
  });

  it("puts a high-risk council warning right under the header, before any number", async (t) => {
    // The demo council already has a high-risk member: a vote that moves funds is the takeover path.
    const { env, chain } = setup(t);
    await say(env, `/yield ${DAO}`, newChat());
    const lines = lastText(chain).split("\n");
    assert.match(lines[1] ?? "", /^🔴 Council keys: HIGH RISK/);
    assert.match(lines[2] ?? "", /^Yield for/);
  });

  it("is rate-limited per chat: the 4th call in a minute is refused without a scan", async (t) => {
    const { env, chain } = setup(t);
    const chat = newChat();
    for (let i = 0; i < 3; i++) await say(env, `/yield ${DAO}`, chat);
    const scans = chain.calls.filter((c) => c.method_name === "get_assets_paged_detailed").length;
    await say(env, `/yield ${DAO}`, chat);
    assert.match(lastText(chain), /Too many requests/);
    assert.equal(chain.calls.filter((c) => c.method_name === "get_assets_paged_detailed").length, scans);
    // Another chat is not held back.
    await say(env, `/yield ${DAO}`, newChat());
    assert.match(lastText(chain), /Yield for/);
  });
});

describe("YD3 /yield_watch and /yield_unwatch", () => {
  it("opts the chat in to yield messages only, records the starting top, and unwatch removes it", async (t) => {
    const { env, chain, db } = setup(t);
    const chat = newChat();
    await say(env, `/yield_watch ${DAO}`, chat);
    assert.match(lastText(chain), /Supply USDC \(test\) on Rhea Lend/);
    assert.doesNotMatch(lastText(chain), /\/yield_watch/, "the chat is already watching");
    assert.deepEqual(rows(db, "SELECT target, network, chat_id FROM yield_watches"), [{ target: DAO, network: "testnet", chat_id: String(chat) }]);
    // Yield is opt-in: it must not create a key-alert subscription.
    assert.equal(rows(db, "SELECT * FROM subscriptions").length, 0);
    const [state] = rows(db, "SELECT top_id, top_apr FROM yield_state");
    assert.equal(state.top_id, TOP);

    await say(env, `/yield_watch ${DAO}`, chat);
    assert.match(lastText(chain), /already/i);
    assert.equal(rows(db, "SELECT * FROM yield_watches").length, 1);

    await say(env, `/yield_unwatch ${DAO}`, chat);
    assert.equal(rows(db, "SELECT * FROM yield_watches").length, 0);
    await say(env, `/yield_unwatch ${DAO}`, chat);
    assert.match(lastText(chain), /not/i);
  });

  it("stores nothing for an account target", async (t) => {
    const { env, db } = setup(t);
    await say(env, "/yield_watch a.kd-demo.testnet", newChat());
    assert.equal(rows(db, "SELECT * FROM yield_watches").length, 0);
    assert.equal(rows(db, "SELECT * FROM yield_state").length, 0);
  });
});

describe("YD3 yield push job", () => {
  it("messages opted-in chats only, only on a real change, and once per change", async (t) => {
    const { env, chain, db } = setup(t);
    const yieldChat = newChat();
    const keyChat = newChat();
    await say(env, `/yield_watch ${DAO}`, yieldChat);
    await say(env, `/watch ${DAO}`, keyChat);
    chain.telegram.length = 0;

    await runJob(env);
    assert.equal(sends(chain).length, 0, "nothing changed since the chat opted in");

    chain.setApr("0.1073"); // +0.2pp: noise, not news
    await runJob(env);
    assert.equal(sends(chain).length, 0);

    chain.setApr("0.1153"); // +1pp from the last message
    await runJob(env);
    assert.equal(sends(chain).length, 1);
    assert.equal(sends(chain)[0]?.body.chat_id, String(yieldChat), "a key-alert subscriber never gets yield messages");
    const text = lastText(chain);
    assert.match(text, /^Key Doctor On Call\n/);
    assert.match(text, /Yield update: kd-demo\.sputnik-dao\.testnet/);
    assert.match(text, /11\.53% APR/);
    assert.equal(rows(db, "SELECT top_apr FROM yield_state")[0].top_apr, 0.1153);

    await runJob(env);
    assert.equal(sends(chain).length, 1, "the same change is not sent twice");
  });

  it("a transient Telegram failure keeps the old top, so the next run sends the change again", async (t) => {
    const { env, chain, db } = setup(t);
    await say(env, `/yield_watch ${DAO}`, newChat());
    chain.setApr("0.1153");
    chain.telegramStatus = 500;
    await runJob(env);
    assert.equal(rows(db, "SELECT top_apr FROM yield_state")[0].top_apr, FIXTURE_APR);

    chain.telegramStatus = 200;
    chain.telegram.length = 0;
    await runJob(env);
    assert.equal(sends(chain).length, 1);
    assert.equal(rows(db, "SELECT top_apr FROM yield_state")[0].top_apr, 0.1153);
  });

  it("a chat that blocked the bot loses its yield watch", async (t) => {
    const { env, chain, db } = setup(t);
    await say(env, `/yield_watch ${DAO}`, newChat());
    chain.setApr("0.1153");
    chain.telegramStatus = 403;
    await runJob(env);
    assert.equal(rows(db, "SELECT * FROM yield_watches").length, 0);
  });

  it("a report with a failed read never pushes: a dropped suggestion is not a change", async (t) => {
    const { env, chain, db } = setup(t);
    await say(env, `/yield_watch ${DAO}`, newChat());
    chain.telegram.length = 0;
    chain.setApr("0.1153");
    chain.get = () => new Response("{}", { status: 500 }); // Rhea API down
    const res = await worker.fetch(
      new Request("https://kd.test/run-check", { method: "POST", headers: { authorization: `Bearer ${RUN_TOKEN}` }, body: JSON.stringify({ job: "yield", target: DAO }) }),
      env,
      ctx,
    );
    const body = (await res.json()) as any;
    assert.equal(res.status, 200);
    assert.equal(body.job, "yield");
    assert.equal(body.alerts_sent, 0);
    assert.ok(body.errors.length > 0);
    assert.equal(sends(chain).length, 0);
    assert.equal(rows(db, "SELECT top_apr FROM yield_state")[0].top_apr, FIXTURE_APR);
  });
});

describe("YD3 yield job: Worker limits", () => {
  it("stays inside the 50 subrequests of the free plan when it pushes to five chats that all blocked the bot", async (t) => {
    const { env, chain, db } = setup(t);
    for (let i = 0; i < 5; i++) await say(env, `/yield_watch ${DAO}`, newChat());
    chain.setApr("0.1153");
    chain.telegramStatus = 403; // each send then costs a delete too
    let gets = 0;
    chain.get = () => {
      gets += 1;
      return new Response(JSON.stringify(MAINNET_API), { status: 200 });
    };
    chain.calls.length = 0;
    chain.telegram.length = 0;
    db.log.length = 0;
    await runJob(env);
    assert.equal(sends(chain).length, 5, "the case must really push");
    const used = chain.calls.length + gets + chain.telegram.length + db.log.length;
    assert.ok(used <= 50, `used ${used}: ${chain.calls.length} RPC, ${gets} GET, ${chain.telegram.length} Telegram, ${db.log.length} D1`);
  });

  it("checks one DAO per cycle by default, the least recently checked first, so every DAO gets its turn", async (t) => {
    const { env, chain, db } = setup(t);
    const other = "kd-other.sputnik-dao.testnet";
    const policy = fixture("rpc/call_function.get_policy.json");
    chain.views.get_policy = () => policy;
    await say(env, `/yield_watch ${DAO}`, newChat());
    await say(env, `/yield_watch ${other}`, newChat());
    // Both watched in the same millisecond would tie; an old, equal time makes the run order exact.
    db.raw.exec("UPDATE yield_state SET checked_at = '2026-01-01T00:00:00.000Z'");
    const read = () => {
      const daos = chain.calls.filter((c) => c.method_name === "get_proposals").map((c) => c.account_id);
      chain.calls.length = 0;
      return daos;
    };
    read();
    await runJob(env);
    const first = read();
    await runJob(env);
    const second = read();
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.deepEqual([...first, ...second].sort(), [DAO, other]);
  });
});

describe("YD3 MCP yield_suggestions", () => {
  const call = async (env: Env, args: unknown) => {
    const res = await worker.fetch(
      new Request("https://kd.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "yield_suggestions", arguments: args } }),
      }),
      env,
      ctx,
    );
    return ((await res.json()) as any).result;
  };

  it("returns the same suggestion as the bot plus the council status, and stores nothing", async (t) => {
    const db = testD1();
    installYieldChain(t);
    const env: Env = { DB: db };
    const r = await call(env, { target: DAO });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.report.schema_version, "kd.yield.v1");
    assert.deepEqual(r.structuredContent.report.suggestions, [{ opportunity_id: TOP, token_id: USDC_T, max_amount: "16500000" }]);
    assert.ok(r.structuredContent.council !== null);
    assert.equal(db.log.length, 0, "an open endpoint must not write or spend anything");
  });

  it("rejects an account and unknown arguments", async (t) => {
    installYieldChain(t);
    const env: Env = { DB: testD1() };
    assert.equal((await call(env, { target: "a.kd-demo.testnet" })).isError, true);
    assert.equal((await call(env, { target: DAO, amount: "1" })).isError, true);
  });
});

// YD2 (plan §2): a TEE model on NEAR AI may order the suggestions and explain them; code checks what comes back.
const QWEN = "Qwen/Qwen3.6-35B-A3B-FP8";
const GLM = "z-ai/glm-5.3-flash";
const KEY = { NEAR_AI_API_KEY: "test-key" };
const chat = (content: string, id = "chatcmpl-test-1") =>
  new Response(JSON.stringify({ id, choices: [{ message: { role: "assistant", content } }] }), { status: 200 });
const order = (reasonEn: string, reasonVi = "Ổn định.") => JSON.stringify({ order: [{ opportunity_id: TOP, reason_vi: reasonVi, reason_en: reasonEn }] });

/** The bot's model cap is per minute and in memory: each test runs in a minute of its own. */
let minute = Date.now();
function ownMinute(t: TestContext): void {
  minute += 120_000;
  t.mock.timers.enable({ apis: ["Date"], now: minute });
}

describe("YD2 /yield with the model step", () => {
  it("shows the model's reason and marks the order as AI-assisted, with the TEE model and generation id", async (t) => {
    ownMinute(t);
    const { env, chain, db } = setup(t, KEY);
    chain.aiReply = () => chat(order("10.53% APR with 16.5 free; 2 open transfers stay covered."));
    await say(env, `/yield ${DAO}`, newChat());
    const text = lastText(chain);
    assert.match(text, /Supply USDC \(test\) on Rhea Lend: 10\.53% APR, up to 16\.50\n  10\.53% APR with 16\.5 free; 2 open transfers stay covered\./);
    assert.match(text, new RegExp(`AI-assisted order and reasons \\(${QWEN} in a NEAR AI TEE, id chatcmpl-test-1\\)\\. Every number comes from code\\.`));

    // The model got the candidates as data, a JSON schema, no tools, and the key as a bearer token.
    assert.equal(chain.ai.length, 1);
    const sent = chain.ai[0]!;
    assert.equal(sent.bearer, true);
    assert.equal(sent.body.model, QWEN);
    assert.equal(sent.body.tools, undefined);
    assert.equal(sent.body.response_format.type, "json_schema");
    const data = JSON.parse(sent.body.messages[1].content);
    assert.deepEqual(data.candidates.map((c: any) => c.opportunity_id), [TOP]);
    assert.equal(data.candidates[0].dao_free, 16.5);

    // Cached: another chat in the same hour gets the same advice without spending the key again.
    const [row] = rows(db, "SELECT target, network FROM yield_advice");
    assert.deepEqual(row, { target: DAO, network: "testnet" });
    await say(env, `/yield ${DAO}`, newChat());
    assert.equal(chain.ai.length, 1);
    assert.match(lastText(chain), /AI-assisted order/);
  });

  it("drops a reason with a number the report does not have, and keeps the AI order mark", async (t) => {
    ownMinute(t);
    const { env, chain } = setup(t, KEY);
    chain.aiReply = () => chat(order("Expect 25% APR next month."));
    await say(env, `/yield ${DAO}`, newChat());
    const text = lastText(chain);
    assert.doesNotMatch(text, /25%/, "a model must not put a made-up yield in front of the council");
    assert.match(text, /AI-assisted order/);
  });

  it("when Qwen fails it goes to the rule order, never to a model off the chain, not even another TEE model (Y5)", async (t) => {
    ownMinute(t);
    const { env, chain } = setup(t, KEY);
    chain.aiReply = (body) => (body.model === QWEN ? new Response("busy", { status: 503 }) : chat(order("Fine.")));
    await say(env, `/yield ${DAO}`, newChat());
    assert.deepEqual(chain.ai.map((x) => x.body.model), [QWEN], `${GLM} answered in 18-23 s in the live compare, past the timeout`);
    assert.deepEqual(chain.ai[0]?.body.chat_template_kwargs, { enable_thinking: false }, "with thinking on, Qwen spent max_tokens on reasoning");
    assert.match(lastText(chain), /Ordered by rules: highest APR first\./);
  });

  it("falls back to the rule order, marked, when every model fails, and caches nothing", async (t) => {
    ownMinute(t); // three /yield calls, under the model cap
    for (const reply of [() => new Response("x", { status: 500 }), () => chat("I think USDC is best."), () => { throw new Error("network"); }]) {
      const { env, chain, db } = setup(t, KEY);
      chain.aiReply = reply;
      await say(env, `/yield ${DAO}`, newChat());
      const text = lastText(chain);
      assert.match(text, /Supply USDC \(test\) on Rhea Lend: 10\.53% APR, up to 16\.50/, "the suggestion itself never depends on the model");
      assert.match(text, /Ordered by rules: highest APR first\./);
      assert.doesNotMatch(text, /AI-assisted/);
      assert.deepEqual(chain.ai.map((x) => x.body.model), [QWEN]);
      assert.equal(rows(db, "SELECT * FROM yield_advice").length, 0, "a fallback is not cached: the next call may reach the model");
    }
  });

  it("without a key it never calls the model and keeps the rule order", async (t) => {
    const { env, chain, db } = setup(t);
    chain.aiReply = () => chat(order("Fine."));
    await say(env, `/yield ${DAO}`, newChat());
    assert.equal(chain.ai.length, 0);
    assert.match(lastText(chain), /Ordered by rules/);
    assert.equal(db.log.length, 0);
  });

  it("caps model calls across chats: past the cap /yield answers with the rule order and spends nothing", async (t) => {
    ownMinute(t);
    const { env, chain } = setup(t, KEY);
    chain.aiReply = () => chat("not json"); // nothing is cached, so every /yield wants the model
    const { YIELD_MODEL_PER_MIN } = await import("../src/telegram/commands.ts");
    for (let i = 0; i < YIELD_MODEL_PER_MIN; i++) await say(env, `/yield ${DAO}`, newChat());
    const spent = chain.ai.length;
    await say(env, `/yield ${DAO}`, newChat());
    assert.equal(chain.ai.length, spent);
    assert.match(lastText(chain), /Ordered by rules/);
  });
});

describe("YD2 push job and MCP with the model step", () => {
  it("the job calls the model only when it pushes, never on a quiet cycle (plan Y20)", async (t) => {
    ownMinute(t);
    const { env, chain } = setup(t, KEY);
    chain.aiReply = () => chat("not json");
    await say(env, `/yield_watch ${DAO}`, newChat());
    chain.ai.length = 0;
    chain.telegram.length = 0;

    await runJob(env);
    chain.setApr("0.1073");
    await runJob(env);
    assert.equal(chain.ai.length, 0, "no push, no model call");

    chain.aiReply = () => chat(order("11.53% APR."), "chatcmpl-push");
    chain.setApr("0.1153");
    await runJob(env);
    assert.equal(sends(chain).length, 1);
    assert.equal(chain.ai.length, 1);
    assert.match(lastText(chain), /11\.53% APR, up to 16\.50\n  11\.53% APR\./);
    assert.match(lastText(chain), /id chatcmpl-push/);
  });

  it("open /mcp serves cached advice only and never spends the key (ADR 0003)", async (t) => {
    ownMinute(t);
    const db = testD1();
    const chain = installYieldChain(t);
    chain.aiReply = () => chat(order("Fine."));
    const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: "1:x", ...KEY };
    const call = async () => {
      const res = await worker.fetch(
        new Request("https://kd.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "yield_suggestions", arguments: { target: DAO } } }),
        }),
        env,
        ctx,
      );
      return ((await res.json()) as any).result.structuredContent;
    };
    const before = await call();
    assert.equal(chain.ai.length, 0);
    assert.equal(before.advice.by, "rules");
    assert.equal(before.advice.fallback, "NO_CACHE");
    assert.equal(writes(db).length, 0);

    await say(env, `/yield ${DAO}`, newChat()); // the bot spends the key and caches the answer
    assert.equal(chain.ai.length, 1);
    const after = await call();
    assert.equal(chain.ai.length, 1);
    assert.equal(after.advice.by, "model");
    assert.equal(after.advice.model, QWEN);
    assert.equal(after.advice.generation_id, "chatcmpl-test-1");
  });
});
