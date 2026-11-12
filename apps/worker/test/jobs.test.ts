import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import worker, { DAILY_CRON, PROPOSAL_CRON } from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { handleUpdate } from "../src/telegram/commands.ts";
import { saveProposalState } from "../src/store/proposal-state.ts";
import { MAX_CHATS_PER_TARGET, addSubscription } from "../src/store/subscriptions.ts";
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
/** A day passes for the daily key diff: every target's last attempt moves 24h back, so each is due again. */
const dayPasses = (db: TestD1) => db.raw.prepare("UPDATE daily_checks SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', checked_at, '-1 day')").run();

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

  it("a chat Telegram refuses for good (400) does not hold the alert back from the others", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, DAO, -1);
    await watch(env, DAO, -2);
    demoProposals(chain);
    chain.telegramReply = (_m, body) =>
      body.chat_id === "-1" ? { status: 400, json: { ok: false, description: "Bad Request: have no rights to send a message" } } : undefined;
    const first = await runCheck(env, { job: "proposals" });
    assert.equal(first.body.alerts_sent, 2);
    assert.equal(rows(db, "SELECT * FROM alerts_sent").length, 2);
    assert.equal(rows(db, "SELECT last_proposal_id FROM proposal_state")[0].last_proposal_id, 6);
    const healthy = () => sends(chain).filter((x) => x.body.chat_id === "-2").length;
    const before = healthy();
    await runCheck(env, { job: "proposals" });
    assert.equal(healthy(), before, "no repeat for the healthy group");
  });

  it("a group upgraded to a supergroup moves its subscription and still gets the alert", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, DAO, -1);
    demoProposals(chain);
    chain.telegramReply = (_m, body) =>
      body.chat_id === "-1"
        ? { status: 400, json: { ok: false, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1009 } } }
        : undefined;
    const r = await runCheck(env, { job: "proposals" });
    assert.equal(r.body.alerts_sent, 2);
    assert.deepEqual(rows(db, "SELECT chat_id, chat_type FROM subscriptions").map((x) => [x.chat_id, x.chat_type]), [["-1009", "supergroup"]]);
    assert.equal(sends(chain).filter((x) => x.body.chat_id === "-1009").length, 2);
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

describe("GĐ28 owner action on an Agent Budget", () => {
  const OWNER = "owner.kd-demo.testnet";
  const FACTORY = "kd-guards.testnet";
  const budget = (chain: Chain) => {
    chain.views.get_last_proposal_id = () => bytes(6);
    chain.views.get_guards_for_dao = () => bytes([{ guard_id: "budget.kd-guards.testnet", dao_id: DAO, name: "x", created_at: "0", ready: true }]);
    chain.views.get_proposal = (args: { id: number }) =>
      bytes({
        id: args.id,
        proposer: OWNER,
        description: "x",
        kind: { Transfer: { token_id: "", receiver_id: "cold.kd-demo.testnet", amount: "40000000000000000000000000", msg: null } },
        status: "Approved",
        vote_counts: {},
        votes: { [OWNER]: "Approve" },
        submission_time: "0",
      });
  };
  const open = { KEEPER_FACTORY_ID: FACTORY, DASHBOARD_URL: "https://dash.test" };

  it("a withdrawal reaches the Budget's chat in one cycle, with the button that checks the account (GĐ28 done-when)", async (t) => {
    const { env, chain } = setup(t, open);
    await watch(env, DAO);
    chain.telegram.length = 0;
    budget(chain);
    const r = await runCheck(env, { job: "proposals" });
    assert.ok(r.body.alerts.includes(`testnet:${DAO}:budget_owner_action:4:1`));
    const told = sends(chain).find((m) => /Just withdrew 40 NEAR to cold/.test(m.body.text));
    assert.match(told!.body.text, /your account may have been taken over/);
    assert.deepEqual(told!.body.reply_markup.inline_keyboard.flat(), [{ text: "Open Key Check for this account", url: `https://dash.test/?target=${OWNER}` }]);
  });

  it("a failed send keeps the proposal state and tells it next run, once", async (t) => {
    const { env, chain, db } = setup(t, open);
    await watch(env, DAO);
    const before = rows(db, "SELECT * FROM proposal_state");
    chain.telegram.length = 0;
    budget(chain);
    chain.telegramStatus = 500;
    await runCheck(env, { job: "proposals" });
    const after = rows(db, "SELECT * FROM proposal_state");
    assert.deepEqual(after.map(({ updated_at, ...r }) => r), before.map(({ updated_at, ...r }) => r));
    assert.ok(after[0].updated_at >= before[0].updated_at, "the DAO moves to the back of the queue (red-team M8)");
    chain.telegramStatus = 200;
    chain.telegram.length = 0;
    await runCheck(env, { job: "proposals" });
    await runCheck(env, { job: "proposals" });
    assert.equal(sends(chain).filter((m) => /Just withdrew/.test(m.body.text)).length, 2, "proposals 4 and 5, each once");
  });

  // Red-team M8: a retry used to resend to every chat, so the chats that got the alert got it again every 15 min.
  it("a retry sends only to the chats that missed the alert", async (t) => {
    const { env, chain } = setup(t, open);
    await watch(env, DAO);
    await watch(env, DAO, -501);
    chain.telegram.length = 0;
    budget(chain);
    let failing = true;
    chain.telegramReply = (method, body) => (method === "sendMessage" && failing && body.chat_id === "-501" ? { status: 500, json: { ok: false } } : undefined);
    await runCheck(env, { job: "proposals" });
    const first = (chat: string) => sends(chain).filter((m) => m.body.chat_id === chat && /Just withdrew/.test(m.body.text)).length;
    assert.equal(first(String(GROUP)), 2, "run 1 reaches one chat with proposals 4 and 5");
    failing = false;
    chain.telegram.length = 0;
    await runCheck(env, { job: "proposals" });
    assert.equal(first(String(GROUP)), 0, "run 2 does not send them again to the chat that got them");
    assert.equal(first("-501"), 2, "run 2 sends both to the chat that missed them");
    chain.telegram.length = 0;
    await runCheck(env, { job: "proposals" });
    assert.equal(sends(chain).length, 0, "once every chat has them, nothing more goes out");
  });

  it("a target takes at most MAX_CHATS_PER_TARGET chats, and an alert goes to at most that many", async (t) => {
    const { env, chain, db } = setup(t, open);
    for (let i = 0; i < MAX_CHATS_PER_TARGET + 2; i++) {
      await addSubscription(db, { target: DAO, network: "testnet", target_type: "dao", chat_id: String(-1000 - i), chat_type: "group", created_at: `2026-11-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    await saveProposalState(db, DAO, "testnet", { last_proposal_id: 4, pending: {} });
    chain.telegram.length = 0;
    await watch(env, DAO);
    assert.match(sends(chain).at(-1)!.body.text, new RegExp(`already has ${MAX_CHATS_PER_TARGET} watching chats`));
    chain.telegram.length = 0;
    budget(chain);
    await runCheck(env, { job: "proposals" });
    const chats = new Set(sends(chain).filter((m) => /Just withdrew/.test(m.body.text)).map((m) => m.body.chat_id));
    assert.equal(chats.size, MAX_CHATS_PER_TARGET);
    assert.ok(!chats.has(String(-1000 - MAX_CHATS_PER_TARGET)), "the newest rows past the cap are left out");
  });

  it("does not ask the testnet factory about a mainnet DAO: it would answer no, and a wrong answer would be silence", async (t) => {
    const { env, chain, db } = setup(t, open);
    await addSubscription(db, { target: "fake.sputnik-dao.near", network: "mainnet", target_type: "dao", chat_id: String(GROUP), chat_type: "group", created_at: "2026-11-01T00:00:00.000Z" });
    await saveProposalState(db, "fake.sputnik-dao.near", "mainnet", { last_proposal_id: 4, pending: {} });
    budget(chain);
    let asked = 0;
    chain.views.get_guards_for_dao = () => (asked++, bytes([]));
    await runCheck(env, { job: "proposals" });
    assert.equal(asked, 0);
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
    dayPasses(db);
    const added = await runCheck(env, { job: "daily" });
    assert.equal(added.body.alerts_sent, 1);
    assert.match(added.body.alerts[0], /^testnet:b\.kd-demo\.testnet:daily_changes:\d{4}-\d{2}-\d{2}@182340111:-$/);
    const msg = sends(chain).at(-1)!.body.text as string;
    assert.match(msg, /Key changes today: b\.kd-demo\.testnet/);
    assert.match(msg, /- b\.kd-demo\.testnet has a new full-access key/);
    assert.match(msg, /verify through another channel now/);

    chain.keys["b.kd-demo.testnet"] = original;
    chain.head += 72_000;
    dayPasses(db);
    const removed = await runCheck(env, { job: "daily" });
    assert.equal(removed.body.alerts_sent, 1);
    assert.match(sends(chain).at(-1)!.body.text, /A full-access key of b\.kd-demo\.testnet was removed/);

    dayPasses(db);
    const none = await runCheck(env, { job: "daily" });
    assert.equal(none.body.alerts_sent, 0);
    assert.ok(rows(db, "SELECT * FROM snapshots").length <= 7);
  });

  it("a failed send keeps the old baseline so the change is reported again", async (t) => {
    const { env, chain, db } = setup(t);
    await watch(env, "b.kd-demo.testnet");
    addKey(chain, "b.kd-demo.testnet", "ed25519:DailyNewKey11111111111111111111111111111111");
    chain.telegramStatus = 500;
    assert.equal((await runCheck(env, { job: "daily" })).body.alerts_sent, 0);
    chain.telegramStatus = 200;
    dayPasses(db);
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

describe("daily key diff rotation (red-team H3)", () => {
  const sub = (env: Env, target: string) =>
    addSubscription(env.DB, { target, network: "testnet", target_type: "account", chat_id: String(GROUP), chat_type: "group", created_at: "2026-11-01T00:00:00Z" });

  it("each run takes at most MAX_DAILY_TARGETS_PER_RUN targets, never checked first; a target checked under 23h ago waits", async (t) => {
    const { env, db } = setup(t, { MAX_DAILY_TARGETS_PER_RUN: "2" });
    for (const a of ["c.kd-demo.testnet", "a.kd-demo.testnet", "b.kd-demo.testnet"]) await sub(env, a);
    assert.equal((await runCheck(env, { job: "daily" })).body.targets_checked, 2);
    // Never checked, then by name: the first run takes a and b. (Read the rows, not checked_at order: two runs can
    // land in the same millisecond.)
    assert.deepEqual(rows(db, "SELECT target FROM daily_checks ORDER BY target").map((r) => r.target), ["a.kd-demo.testnet", "b.kd-demo.testnet"]);
    const second = await runCheck(env, { job: "daily" });
    assert.equal(second.body.targets_checked, 1);
    assert.equal(rows(db, "SELECT target FROM daily_checks").length, 3, "the second run takes c, the one left");
    assert.equal((await runCheck(env, { job: "daily" })).body.targets_checked, 0);
    dayPasses(db);
    assert.equal((await runCheck(env, { job: "daily" })).body.targets_checked, 2);
  });

  it("targets that sort first and always fail cannot starve a real one: its new key still alerts within a day", async (t) => {
    // The old job scanned every target alphabetically in one invocation, so cheap junk subscriptions that sort first
    // used up the subrequest budget and the targets after them were never scanned.
    const { env, chain, db } = setup(t, { MAX_DAILY_TARGETS_PER_RUN: "2" });
    for (const junk of ["aaa-1.testnet", "aaa-2.testnet", "aaa-3.testnet"]) await sub(env, junk);
    await watch(env, "b.kd-demo.testnet");
    dayPasses(db); // the /watch baseline is old news by the time the daily runs start
    addKey(chain, "b.kd-demo.testnet", "ed25519:DailyNewKey11111111111111111111111111111111");
    const runs = [];
    for (let hour = 0; hour < 24; hour++) {
      const r = await runCheck(env, { job: "daily" });
      runs.push(r.body);
      if (r.body.alerts_sent > 0) break;
    }
    assert.ok(runs.length <= 2, `the alert took ${runs.length} runs`);
    assert.match(sends(chain).at(-1)!.body.text, /b\.kd-demo\.testnet has a new full-access key/);
    assert.ok(runs[0].errors.length > 0, "the junk targets were tried and failed");
  });

  it("a target named in /run-check runs now even if it was checked minutes ago", async (t) => {
    const { env } = setup(t);
    await sub(env, "b.kd-demo.testnet");
    assert.equal((await runCheck(env, { job: "daily" })).body.targets_checked, 1);
    assert.equal((await runCheck(env, { job: "daily" })).body.targets_checked, 0);
    assert.equal((await runCheck(env, { job: "daily", target: "B.kd-demo.testnet" })).body.targets_checked, 1);
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
