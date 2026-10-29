import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import worker, { DAILY_CRON, PROPOSAL_CRON } from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { handleUpdate } from "../src/telegram/commands.ts";
import { testD1, type TestD1 } from "./support/d1.ts";
import { DAO, addKey, bytes, fixture, installChain, type Chain } from "./support/rpc.ts";

const RUN_TOKEN = "run-token";
const GROUP = -500;

function setup(t: TestContext, extra: Partial<Env> = {}) {
  const db = testD1();
  const chain = installChain(t);
  const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: "1:x", RUN_CHECK_TOKEN: RUN_TOKEN, ALERT_LANG: "en", ...extra };
  return { db, chain, env };
}

const watch = (env: Env, target: string, chat = GROUP) =>
  handleUpdate({ message: { text: `/watch ${target}`, chat: { id: chat, type: "group" }, from: { language_code: "en" } } }, env);

async function runCheck(env: Env, body: unknown, token = RUN_TOKEN) {
  const res = await worker.fetch(
    new Request("https://kd.test/run-check", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
    env,
    { waitUntil: () => {} },
  );
  return { status: res.status, body: (await res.json()) as any };
}

/** The demo: transfer proposal 4 that a (with a fresh full-access key) approved, and governance proposal 5. */
function demoProposals(chain: Chain) {
  const transfer = { ...fixture("sputnik/get_proposal.2.transfer.json"), id: 4 };
  const addMember = { ...fixture("sputnik/get_proposal.3.add_member.json"), id: 5 };
  const proposals: Record<number, unknown> = { 4: transfer, 5: addMember };
  chain.views.get_last_proposal_id = () => bytes(6);
  chain.views.get_proposal = (args: { id: number }) => bytes(proposals[args.id]);
  return proposals;
}
const sends = (chain: Chain) => chain.telegram.filter((x) => x.method === "sendMessage");
const rows = (db: TestD1, sql: string) => db.raw.prepare(sql).all() as any[];

describe("GĐ6 /run-check", () => {
  it("needs the Bearer token and a known job", async (t) => {
    const { env } = setup(t);
    assert.equal((await runCheck(env, { job: "proposals" }, "nope")).status, 401);
    assert.equal((await runCheck({ ...env, RUN_CHECK_TOKEN: "" }, { job: "proposals" }, "")).status, 401);
    assert.equal((await runCheck(env, { job: "other" })).status, 400);
    assert.equal((await runCheck(env, { job: "proposals", target: 5 })).status, 400);
    assert.equal((await runCheck(env, { job: "proposals", target: "Bad Name" })).body.code, "INVALID_TARGET");
  });
});

describe("GĐ6 proposal watch (demo scenario)", () => {
  it("watch, then a transfer approved by a compromised member and a governance proposal: the group gets both alerts before the second vote", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, DAO);
    chain.telegram.length = 0;
    demoProposals(chain);
    const r = await runCheck(env, { job: "proposals" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      job: "proposals",
      targets_checked: 1,
      alerts_sent: 2,
      alerts: [
        `testnet:${DAO}:voter_new_full_access_key:4:a.kd-demo.testnet`,
        `testnet:${DAO}:governance_change_proposal:5:-`,
      ],
      errors: [],
    });
    const [voter, gov] = sends(chain);
    assert.equal(voter?.body.chat_id, String(GROUP));
    assert.match(voter!.body.text, /a\.kd-demo\.testnet has a new full-access key added about 3 hours before voting/);
    assert.match(voter!.body.text, /Still to vote: b\.kd-demo\.testnet, c\.kd-demo\.testnet/);
    assert.match(voter!.body.text, /Before you vote: verify with a\.kd-demo\.testnet through another channel/);
    assert.match(gov!.body.text, /GOVERNANCE CHANGE/);
    assert.equal(rows(db, "SELECT * FROM alerts_sent").length, 2);
    const state = rows(db, "SELECT * FROM proposal_state")[0];
    assert.equal(state.last_proposal_id, 6);
    assert.deepEqual(Object.keys(JSON.parse(state.pending_json)), ["4", "5"]);
  });

  it("a second run with nothing new sends nothing (UC6 done-when)", async (t) => {
    const { env, chain } = setup(t);
    await watch(env, DAO);
    demoProposals(chain);
    await runCheck(env, { job: "proposals" });
    const before = sends(chain).length;
    const again = await runCheck(env, { job: "proposals" });
    assert.equal(again.body.alerts_sent, 0);
    assert.deepEqual(again.body.alerts, []);
    assert.equal(sends(chain).length, before);
  });

  it("one checkProposals per DAO even with several watching chats; every chat gets the alert", async (t) => {
    const { env, chain } = setup(t);
    await watch(env, DAO, -1);
    await watch(env, DAO, -2);
    demoProposals(chain);
    const policyCalls = () => chain.calls.filter((c) => c.method_name === "get_last_proposal_id").length;
    const start = policyCalls();
    const r = await runCheck(env, { job: "proposals" });
    assert.equal(policyCalls() - start, 1);
    assert.equal(r.body.alerts_sent, 2);
    assert.deepEqual(sends(chain).slice(-4).map((s) => s.body.chat_id).sort(), ["-1", "-1", "-2", "-2"]);
  });

  it("a transient send failure keeps the old state and the alert is sent on the next run", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, DAO);
    demoProposals(chain);
    chain.telegramStatus = 500;
    const failed = await runCheck(env, { job: "proposals" });
    assert.equal(failed.body.alerts_sent, 0);
    assert.equal(failed.body.errors.length, 2);
    assert.equal(rows(db, "SELECT * FROM alerts_sent").length, 0);
    assert.equal(rows(db, "SELECT last_proposal_id FROM proposal_state")[0].last_proposal_id, 4);
    chain.telegramStatus = 200;
    const retried = await runCheck(env, { job: "proposals" });
    assert.equal(retried.body.alerts_sent, 2);
  });

  it("a chat that removed the bot loses its subscription", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, DAO);
    demoProposals(chain);
    chain.telegramStatus = 403;
    await runCheck(env, { job: "proposals" });
    assert.equal(rows(db, "SELECT * FROM subscriptions").length, 0);
  });

  it("a checkProposals throw is reported and the state is not saved", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, DAO);
    const before = rows(db, "SELECT * FROM proposal_state");
    chain.views.get_last_proposal_id = () => ({ jsonrpc: "2.0", id: "kd", result: { result: [1, 2], logs: [] } });
    const r = await runCheck(env, { job: "proposals" });
    assert.equal(r.body.targets_checked, 0);
    assert.deepEqual(r.body.errors, [`${DAO}: NOT_A_DAO`]);
    assert.deepEqual(rows(db, "SELECT * FROM proposal_state"), before);
  });

  it("an account-only subscription is not proposal-checked; a target can be named", async (t) => {
    const { env, chain } = setup(t);
    await watch(env, "b.kd-demo.testnet");
    assert.equal((await runCheck(env, { job: "proposals" })).body.targets_checked, 0);
    demoProposals(chain);
    const named = await runCheck(env, { job: "proposals", target: DAO });
    assert.equal(named.body.targets_checked, 1);
    // Nobody watches the DAO, so nothing is sent and the state only records the count.
    assert.equal(named.body.alerts_sent, 0);
  });

  it("alerts are bilingual by default", async (t) => {
    const { env, chain } = setup(t, { ALERT_LANG: undefined });
    await watch(env, DAO);
    demoProposals(chain);
    await runCheck(env, { job: "proposals" });
    const text = sends(chain).at(-1)!.body.text as string;
    assert.match(text, /ĐỔI QUYỀN DAO/);
    assert.match(text, /— English —\nGOVERNANCE CHANGE/);
  });
});

describe("GĐ9 daily key diff", () => {
  it("a new key on a watched account arrives the next run; removing it arrives the run after; no change sends nothing (UC7 done-when)", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, "b.kd-demo.testnet");
    const quiet = await runCheck(env, { job: "daily" });
    assert.deepEqual([quiet.body.targets_checked, quiet.body.alerts_sent], [1, 0]);

    const original = structuredClone(chain.keys["b.kd-demo.testnet"]);
    addKey(chain, "b.kd-demo.testnet", "ed25519:DailyNewKey11111111111111111111111111111111");
    const added = await runCheck(env, { job: "daily" });
    assert.equal(added.body.alerts_sent, 1);
    assert.match(added.body.alerts[0], /^testnet:b\.kd-demo\.testnet:daily_changes:\d{4}-\d{2}-\d{2}@182340111:-$/);
    const msg = sends(chain).at(-1)!.body.text as string;
    assert.match(msg, /Key changes today: b\.kd-demo\.testnet/);
    assert.match(msg, /- b\.kd-demo\.testnet has a new full-access key/);
    assert.match(msg, /verify through another channel now/);

    chain.keys["b.kd-demo.testnet"] = original;
    chain.head += 72_000;
    const removed = await runCheck(env, { job: "daily" });
    assert.equal(removed.body.alerts_sent, 1);
    assert.match(sends(chain).at(-1)!.body.text, /A full-access key of b\.kd-demo\.testnet was removed/);

    const none = await runCheck(env, { job: "daily" });
    assert.equal(none.body.alerts_sent, 0);
    assert.ok(rows(db, "SELECT * FROM snapshots").length <= 7);
  });

  it("a failed send keeps the old baseline so the change is reported again", async (t) => {
    const { env, chain } = setup(t);
    await watch(env, "b.kd-demo.testnet");
    addKey(chain, "b.kd-demo.testnet", "ed25519:DailyNewKey11111111111111111111111111111111");
    chain.telegramStatus = 500;
    assert.equal((await runCheck(env, { job: "daily" })).body.alerts_sent, 0);
    chain.telegramStatus = 200;
    const retry = await runCheck(env, { job: "daily" });
    assert.equal(retry.body.alerts_sent, 1);
  });

  it("keeps at most 7 snapshots per target", async (t) => {
    const { env, db } = setup(t);
    await watch(env, "b.kd-demo.testnet");
    for (let i = 0; i < 9; i++) {
      db.raw.prepare("INSERT INTO snapshots VALUES ('b.kd-demo.testnet', 'testnet', ?, ?, '{}')").run(`2026-10-0${i}T00:00:00Z`, i);
    }
    await runCheck(env, { job: "daily" });
    assert.equal(rows(db, "SELECT * FROM snapshots").length, 7);
  });
});

describe("crons", () => {
  it("scheduled dispatches each cron to its job inside waitUntil", async (t) => {
    const { env, chain } = setup(t);
    await watch(env, DAO);
    demoProposals(chain);
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron: PROPOSAL_CRON, scheduledTime: 0 }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.equal(sends(chain).filter((s) => /GOVERNANCE CHANGE/.test(s.body.text)).length, 1);
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: 0 }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  });
});
