import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Plan } from "key-doctor";
import worker, { KEEPER_CRON } from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { runKeeperJob } from "../src/jobs/keeper.ts";
import { base58Decode, base58Encode } from "../src/keeper/near.ts";
import { addSubscription } from "../src/store/subscriptions.ts";
import { handleUpdate } from "../src/telegram/commands.ts";
import { testD1, type TestD1 } from "./support/d1.ts";
import { DAO, HEAD, bytes, installChain, type Chain } from "./support/rpc.ts";

const KEEPER = "keeper.kd-demo.testnet";
const FACTORY = "kd-guards.testnet";
const GUARD = "payroll.kd-guards.testnet";
const CHAT = "-500";
const TEAM = "-900";
const NEAR = 10n ** 24n;
// Test value, never funded. A fixed seed so the "never leaks" test knows what to look for.
const SECRET = `ed25519:${base58Encode(new Uint8Array(32).fill(9))}`;
const HOUR_BLOCKS = 6000; // the stub clock moves 600 ms per block
const HOUR_NS = 3_600_000_000_000n;
const headNs = (head: number) => BigInt(1793671210000 + (head - HEAD) * 600) * 1_000_000n;

/** The Guard's answers to `execute_plan_step` and `sync_request`, as `contracts/guard` gives them. */
class FakeGuard {
  guard_id: string;
  dao_id: string;
  plans: Plan[] = [];
  requests: any[] = [];
  /** What `get_config` says. */
  paused = false;
  /** What the next step meets. */
  next: "ok" | "over_limit" | "short" | "paused_guard" | "below_floor" | "floor_required" = "ok";
  /** What the next sync finds: the DAO has paid, has not settled yet, or the payment failed. */
  syncFinds: "paid" | "open" | "failed" = "paid";
  calls: { method: string; args: any; nonce: bigint; gas: bigint; deposit: bigint; signer: string }[] = [];

  constructor(guard_id = GUARD, dao_id = DAO) {
    this.guard_id = guard_id;
    this.dao_id = dao_id;
  }

  plan(over: Partial<Plan> = {}): Plan {
    const plan: Plan = {
      plan_id: this.plans.length,
      action: { type: "transfer", receiver_id: "bob.kd-demo.testnet" },
      strategy_id: "scheduled-payouts",
      token_in: "",
      amount_per_run: NEAR.toString(),
      interval_sec: 3600,
      runs_total: 3,
      runs_done: 0,
      start_at: headNs(HEAD).toString(),
      next_run_at: headNs(HEAD).toString(),
      status: "active",
      pause_reason: null,
      ...over,
    };
    this.plans.push(plan);
    return plan;
  }

  execute(planId: number, head: number) {
    const plan = this.plans[planId]!;
    if (this.next === "paused_guard") return panic("PAUSED");
    if (plan.status !== "active") return panic("PLAN_NOT_ACTIVE");
    if (BigInt(plan.next_run_at!) > headNs(head)) return panic("PLAN_NOT_DUE");
    const due = plan.next_run_at!;
    const run = plan.runs_done + 1;
    if (this.next === "over_limit") {
      plan.next_run_at = (BigInt(due) + HOUR_NS).toString();
      return success(this.guard_id, null, [event("plan_step_skipped", { plan_id: planId, run, reason: "OVER_DAILY_LIMIT", due })]);
    }
    if (this.next === "below_floor") {
      // Guard 1.5.0 on_quote: the slot moves on, runs_done does not, and the daily limit is given back.
      plan.next_run_at = (BigInt(due) + HOUR_NS).toString();
      return success(this.guard_id, null, [event("plan_step_skipped", { plan_id: planId, run, reason: "PRICE_BELOW_FLOOR", due })]);
    }
    if (this.next === "floor_required") {
      plan.status = "paused";
      plan.pause_reason = "price_floor_required";
      return success(this.guard_id, null, [event("plan_paused", { plan_id: planId, reason: "price_floor_required", code: "PRICE_FLOOR_REQUIRED" })]);
    }
    if (this.next === "short") {
      plan.status = "paused";
      plan.pause_reason = "insufficient_balance";
      return success(this.guard_id, null, [event("plan_paused", { plan_id: planId, reason: "insufficient_balance", code: "VOTE_FAILED" })]);
    }
    plan.next_run_at = (BigInt(due) + HOUR_NS).toString();
    plan.runs_done = run;
    const logs = [event("plan_step_executed", { plan_id: planId, run, request_id: `plan-${planId}-${due}`, proposal_id: 40 + run })];
    if (run === plan.runs_total) {
      plan.status = "completed";
      plan.next_run_at = null;
      logs.push(event("plan_completed", { plan_id: planId, runs: run }));
    }
    const record = { request_id: `plan-${planId}-${due}`, memo: `plan ${planId} run ${run}`, proposal_id: 40 + run, status: "AutoApproved", plan_id: planId, updated_at: due };
    this.requests.unshift(record);
    return success(this.guard_id, record, logs);
  }

  sync(requestId: string) {
    const r = this.requests.find((x) => x.request_id === requestId);
    const finds = this.syncFinds;
    this.syncFinds = "paid";
    if (finds === "open") return success(this.guard_id, r, []);
    if (finds === "paid") {
      r.status = "Executed";
      return success(this.guard_id, r, []);
    }
    r.status = "Failed";
    const plan = this.plans[r.plan_id]!;
    plan.runs_done -= 1;
    plan.status = "paused";
    plan.pause_reason = "failures";
    return success(this.guard_id, r, [event("plan_paused", { plan_id: r.plan_id, reason: "failures", code: "PROPOSAL_FAILED" })]);
  }
}

const event = (name: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "kd_guard", version: "1.0.0", event: name, data: [data] })}`;
const success = (executor: string, value: unknown, logs: string[]) => ({
  status: { SuccessValue: btoa(JSON.stringify(value)) },
  receipts_outcome: [{ outcome: { logs, executor_id: executor } }],
});
const panic = (code: string) => ({
  status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } } } } },
  receipts_outcome: [{ outcome: { logs: [] } }],
});

/** Reads a signed transaction back, so the tests check the bytes that would reach the chain. */
function decodeTx(b64: string) {
  const b = Buffer.from(b64, "base64");
  let o = 0;
  const str = () => {
    const n = b.readUInt32LE(o);
    o += 4 + n;
    return b.subarray(o - n, o).toString();
  };
  const signer = str();
  o += 33;
  const nonce = b.readBigUInt64LE(o);
  o += 8;
  const receiver = str();
  o += 32;
  assert.equal(b.readUInt32LE(o), 1, "one action");
  o += 4;
  assert.equal(b[o], 2, "a FunctionCall");
  o += 1;
  const method = str();
  const args = JSON.parse(str());
  const gas = b.readBigUInt64LE(o);
  o += 8;
  const deposit = b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
  return { signer, nonce, receiver, method, args, gas, deposit };
}

function setup(t: TestContext, guards: FakeGuard[] = [new FakeGuard()], extra: Partial<Env> = {}) {
  const db = testD1();
  const chain = installChain(t);
  chain.blockHash = base58Encode(new Uint8Array(32).fill(7));
  chain.balances[KEEPER] = (3n * NEAR).toString();
  const env: Env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: "1:x",
    RUN_CHECK_TOKEN: "run-token",
    ALERT_LANG: "en",
    DASHBOARD_URL: "https://dash.test",
    KEEPER_ACCOUNT_ID: KEEPER,
    KEEPER_PRIVATE_KEY: SECRET,
    KEEPER_FACTORY_ID: FACTORY,
    KEEPER_ALERT_CHAT_ID: TEAM,
    ...extra,
  };
  const byId = (id: string) => guards.find((g) => g.guard_id === id)!;
  chain.views.list_guards = (a: { from_index: number; limit: number }) =>
    bytes(guards.slice(a.from_index, a.from_index + a.limit).map((g) => ({ guard_id: g.guard_id, dao_id: g.dao_id, name: "x", created_at: "0", ready: true })));
  chain.views.get_config = (_a, id) => bytes({ paused: byId(id).paused });
  chain.views.get_plans = (_a, id) => bytes(structuredClone(byId(id).plans));
  chain.views.list_requests = (_a, id) => bytes(structuredClone(byId(id).requests));
  chain.sendTx = (b64) => {
    const tx = decodeTx(b64);
    chain.accessKeyNonce = Number(tx.nonce);
    const g = byId(tx.receiver);
    g.calls.push(tx);
    return tx.method === "execute_plan_step" ? g.execute(tx.args.plan_id, chain.head) : g.sync(tx.args.request_id);
  };
  return { db, chain, env, guard: guards[0]! };
}

const watch = (env: Env, target: string, chat = Number(CHAT)) =>
  handleUpdate({ message: { text: `/watch ${target}`, chat: { id: chat, type: "group" }, from: { language_code: "en" } } }, env);
const sends = (chain: Chain) => chain.telegram.filter((x) => x.method === "sendMessage");
const texts = (chain: Chain) => sends(chain).map((x) => String(x.body.text));
const buttons = (m: { body: any }): { text: string; url: string }[] => m.body.reply_markup?.inline_keyboard?.flat() ?? [];
const rows = (db: TestD1, sql: string) => db.raw.prepare(sql).all() as any[];
const rpcMethods = (chain: Chain) => chain.calls.map((c) => c.method_name ?? c.request_type ?? c.method);

/** Watches the DAO and forgets the bot's reply, so only keeper messages are left. */
async function watched(env: Env, chain: Chain, target = DAO) {
  await watch(env, target);
  chain.telegram.length = 0;
}
const nextHour = (chain: Chain) => {
  chain.head += HOUR_BLOCKS;
};

describe("GĐ28 keeper: a guardian's pause has no proposal to read", () => {
  const told = (chain: Chain) => texts(chain).filter((x) => /Just paused every agent/.test(x));

  it("tells the pause once, on a Budget with no plan too, and tells the next pause again", async (t) => {
    const { env, chain, guard } = setup(t);
    await watched(env, chain);
    assert.equal(guard.plans.length, 0);
    guard.paused = true;
    await runKeeperJob(env);
    await runKeeperJob(env);
    assert.equal(told(chain).length, 1, "a pause lasting many cycles is one message");
    const m = sends(chain).find((x) => /Just paused/.test(String(x.body.text)))!;
    assert.deepEqual(buttons(m), [{ text: "Open Agent Budget", url: `https://dash.test/?page=budget&dao=${DAO}` }], "nothing on chain names who paused");

    guard.paused = false;
    await runKeeperJob(env);
    guard.paused = true;
    await runKeeperJob(env);
    assert.equal(told(chain).length, 2);
  });

  it("a failed send is sent again next cycle", async (t) => {
    const { env, chain, guard } = setup(t);
    await watched(env, chain);
    guard.paused = true;
    chain.telegramReply = (_m, body) => (/Just paused/.test(String(body.text)) ? { status: 500, json: { ok: false } } : undefined);
    await runKeeperJob(env);
    chain.telegramReply = undefined;
    chain.telegram.length = 0;
    await runKeeperJob(env);
    assert.equal(told(chain).length, 1);
  });

  it("a pause nobody watched is not replayed to a later /watch", async (t) => {
    const { env, chain, guard } = setup(t);
    guard.paused = true;
    await runKeeperJob(env);
    await watched(env, chain);
    await runKeeperJob(env);
    assert.equal(told(chain).length, 0);
  });
});

describe("GĐ29 keeper: when it may run", () => {
  it("stays off, without a single read, until the owner sets the account, the key and the factory", async (t) => {
    const { env, chain, db } = setup(t);
    for (const off of ["KEEPER_ACCOUNT_ID", "KEEPER_PRIVATE_KEY", "KEEPER_FACTORY_ID"] as const) {
      const r = await runKeeperJob({ ...env, [off]: "" });
      assert.equal(r.skipped, "not_configured");
    }
    assert.equal(chain.calls.length, 0);
    assert.equal(db.log.length, 0);
  });

  it("refuses a mainnet account or factory: ADR 0005 is for testnet only", async (t) => {
    const { env, chain, guard } = setup(t);
    guard.plan();
    for (const bad of [{ KEEPER_ACCOUNT_ID: "keeper.near" }, { KEEPER_FACTORY_ID: "guards.near" }]) {
      const r = await runKeeperJob({ ...env, ...bad });
      assert.match(r.errors[0]!, /^KEEPER_NOT_TESTNET/);
    }
    assert.equal(chain.calls.length, 0);
  });

  it("two cycles never overlap: the second one stands down and touches nothing", async (t) => {
    const { env, guard, chain } = setup(t);
    guard.plan();
    const [a, b] = await Promise.all([runKeeperJob(env), runKeeperJob(env)]);
    assert.deepEqual([a.skipped, b.skipped].sort(), ["locked", null].sort());
    assert.equal(guard.calls.filter((c) => c.method === "execute_plan_step").length, 1);
    assert.ok(chain.calls.length > 0);
  });

  it("a cycle that died does not lock the keeper forever: its lease runs out", async (t) => {
    const { env, db, guard } = setup(t);
    guard.plan();
    db.raw.exec("INSERT INTO keeper_state (id, lease_until, guard_cursor) VALUES (1, '2099-01-01T00:00:00.000Z', 0)");
    assert.equal((await runKeeperJob(env)).skipped, "locked");
    db.raw.exec("UPDATE keeper_state SET lease_until = '2020-01-01T00:00:00.000Z'");
    assert.equal((await runKeeperJob(env)).steps_run, 1);
  });

  it("gives the lease back after a failed read, so the next cycle runs at once", async (t) => {
    const { env, chain } = setup(t);
    const list = chain.views.list_guards!;
    chain.views.list_guards = () => new Error("x");
    const failed = await runKeeperJob(env);
    assert.equal(failed.errors.length, 1);
    chain.views.list_guards = list;
    assert.equal((await runKeeperJob(env)).skipped, null);
  });
});

describe("GĐ29 keeper: what it signs", () => {
  it("calls a due step with no deposit, from the keeper, to the Guard only (K2a, K3)", async (t) => {
    const { env, guard } = setup(t);
    guard.plan();
    await runKeeperJob(env);
    const [call] = guard.calls;
    assert.equal(call!.method, "execute_plan_step");
    assert.deepEqual(call!.args, { plan_id: 0 });
    assert.equal(call!.signer, KEEPER);
    assert.equal(call!.deposit, 0n);
    assert.equal(call!.gas, 300_000_000_000_000n);
  });

  it("does nothing before the step is due, and leaves the key alone", async (t) => {
    const { env, chain, guard } = setup(t);
    guard.plan({ next_run_at: (headNs(HEAD) + 1n).toString() });
    const r = await runKeeperJob(env);
    assert.equal(r.steps_run, 0);
    assert.equal(guard.calls.length, 0);
    assert.ok(!rpcMethods(chain).includes("view_access_key"), "no key work on an idle cycle: CPU is the free plan's scarce thing");
  });

  it("leaves plans alone that are not active", async (t) => {
    const { env, guard } = setup(t);
    guard.plan({ status: "paused", pause_reason: "owner" });
    guard.plan({ status: "cancelled" });
    guard.plan({ status: "completed", next_run_at: null });
    await runKeeperJob(env);
    assert.equal(guard.calls.length, 0);
  });

  it("uses a fresh nonce for each transaction of a cycle, or the second one would be refused", async (t) => {
    const { env, guard } = setup(t);
    guard.plan();
    guard.plan();
    await runKeeperJob(env);
    assert.deepEqual(guard.calls.map((c) => c.nonce).slice(0, 2), [101n, 102n]);
  });

  it("stops at the step limit and leaves the rest due for the next cycle", async (t) => {
    const { env, guard } = setup(t, undefined, { KEEPER_MAX_STEPS_PER_RUN: "2" });
    for (let i = 0; i < 3; i++) guard.plan();
    assert.equal((await runKeeperJob(env)).steps_run, 2);
    assert.equal((await runKeeperJob(env)).steps_run, 1);
  });

  it("a lost call to another caller is no error: anyone may call a step (K2)", async (t) => {
    const { env, chain, guard } = setup(t);
    const plan = guard.plan();
    const send = chain.sendTx!;
    chain.sendTx = (b64) => {
      plan.next_run_at = (headNs(chain.head) + HOUR_NS).toString(); // someone else got there first
      return send(b64);
    };
    const r = await runKeeperJob(env);
    assert.deepEqual(r.errors, []);
    assert.equal(rows(env.DB as TestD1, "SELECT * FROM plan_steps").length, 0);
  });

  it("after a send that may have landed it stops signing, because its nonce is no longer known", async (t) => {
    const { env, chain, guard, db } = setup(t);
    guard.plan();
    guard.plan();
    const send = chain.sendTx!;
    chain.sendTx = undefined; // the RPC answers 500
    const r = await runKeeperJob(env);
    assert.equal(r.steps_run, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, new RegExp(`^${GUARD}: execute_plan_step \\w+: RPC_HTTP_500$`), "the hash lets the team find it");
    assert.equal(rows(db, "SELECT * FROM plan_steps").length, 0, "no row for what is not known");
    chain.sendTx = send;
    assert.equal((await runKeeperJob(env)).steps_run, 2);
  });

  it("reports a Guard that refuses, and moves on to the next Guard", async (t) => {
    const stopped = new FakeGuard();
    const fine = new FakeGuard("other.kd-guards.testnet", "other.sputnik-dao.testnet");
    const { env, chain } = setup(t, [stopped, fine]);
    chain.views.get_policy = () => bytes({ roles: [] });
    stopped.plan();
    fine.plan();
    stopped.next = "paused_guard";
    const r = await runKeeperJob(env);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /plan 0: PAUSED/);
    assert.equal(fine.calls.filter((c) => c.method === "execute_plan_step").length, 1);
  });

  it("a Guard whose DAO is not a Sputnik DAO takes no slot and gets no signature (red-team M2)", async (t) => {
    // The factory takes any contract that answers get_policy as a DAO, so anyone can flood it with Guards.
    // Those must not push a real Budget's plan out of the cycle's few slots or spend the keeper's gas.
    const junk = [0, 1, 2, 3].map((i) => new FakeGuard(`j${i}.kd-guards.testnet`, `fake${i}.testnet`));
    const real = new FakeGuard("real.kd-guards.testnet", "real.sputnik-dao.testnet");
    const { env, chain } = setup(t, [...junk, real]);
    chain.views.get_policy = () => bytes({ roles: [] });
    [...junk, real].forEach((g) => g.plan());
    const r = await runKeeperJob(env);
    assert.equal(r.targets_checked, 1);
    assert.equal(real.calls.filter((c) => c.method === "execute_plan_step").length, 1, "the real Budget runs in the first cycle");
    assert.deepEqual(junk.map((g) => g.calls.length), [0, 0, 0, 0]);
    assert.equal(rows(env.DB as TestD1, "SELECT guard_cursor FROM keeper_state")[0].guard_cursor, 0, "the whole list was one page");
  });

  it("one Guard gets at most KEEPER_MAX_TXS_PER_GUARD_PER_DAY keeper transactions a day (red-team M2)", async (t) => {
    // A plan may be due every minute and the keeper pays the gas: without a share, one Guard drains it below the minimum.
    const greedy = new FakeGuard();
    const other = new FakeGuard("other.kd-guards.testnet", "other.sputnik-dao.testnet");
    const { env, chain } = setup(t, [greedy, other], { KEEPER_MAX_TXS_PER_GUARD_PER_DAY: "2" });
    chain.views.get_policy = () => bytes({ roles: [] });
    for (let i = 0; i < 3; i++) greedy.plan();
    other.plan();
    const first = await runKeeperJob(env);
    assert.equal(greedy.calls.length, 2, "stopped at its share");
    assert.ok(first.errors.some((e) => /used its 2 keeper transactions/.test(e)));
    assert.equal(other.calls.filter((c) => c.method === "execute_plan_step").length, 1, "another Guard still runs");
    nextHour(chain);
    await runKeeperJob(env);
    assert.equal(greedy.calls.length, 2, "the share holds across cycles of the same day");
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(rows(env.DB as TestD1, `SELECT txs FROM keeper_txs WHERE guard_id = '${greedy.guard_id}' AND day = '${today}'`).map((r) => r.txs), [2]);
  });

  it("works through every Guard of the factory in turn, however many there are", async (t) => {
    const guards = [0, 1, 2, 3, 4].map((i) => new FakeGuard(`g${i}.kd-guards.testnet`, `d${i}.sputnik-dao.testnet`));
    const { env, chain } = setup(t, guards);
    chain.views.get_policy = () => bytes({ roles: [] });
    guards.forEach((g) => g.plan());
    await runKeeperJob(env);
    assert.deepEqual(guards.map((g) => g.calls.length > 0), [true, true, true, false, false]);
    await runKeeperJob(env);
    assert.deepEqual(guards.map((g) => g.calls.length > 0), [true, true, true, true, true]);
    assert.equal(rows(env.DB as TestD1, "SELECT guard_cursor FROM keeper_state")[0].guard_cursor, 0, "wraps around");
  });

  it("does not waste a cycle when the Guard count is a multiple of the page size", async (t) => {
    // Three Guards fill the page, so the cursor lands on 3, past the end. The next cycle must wrap to 0 at once,
    // or a plan due every 15 minutes runs only every 30 (seen live on payroll-2, 2026-11-09).
    const guards = [0, 1, 2].map((i) => new FakeGuard(`g${i}.kd-guards.testnet`, `d${i}.sputnik-dao.testnet`));
    const { env, chain } = setup(t, guards);
    chain.views.get_policy = () => bytes({ roles: [] });
    guards.forEach((g) => g.plan());
    await runKeeperJob(env);
    assert.equal(rows(env.DB as TestD1, "SELECT guard_cursor FROM keeper_state")[0].guard_cursor, 3);
    nextHour(chain);
    const r = await runKeeperJob(env);
    assert.equal(r.targets_checked, 3);
    const steps = (g: FakeGuard) => g.calls.filter((c) => c.method === "execute_plan_step").length;
    assert.deepEqual(guards.map(steps), [2, 2, 2], "every Guard runs its next step in the very next cycle");
    assert.equal(rows(env.DB as TestD1, "SELECT guard_cursor FROM keeper_state")[0].guard_cursor, 3);
  });
});

describe("GĐ29 keeper: K1, no privileged keeper", () => {
  it("signs nothing for a Budget whose DAO has the keeper as a member", async (t) => {
    const { env, chain, guard } = setup(t);
    chain.views.get_policy = () => bytes({ roles: [{ kind: "Everyone" }, { kind: { Group: ["owner.kd-demo.testnet", KEEPER] } }] });
    guard.plan();
    const r = await runKeeperJob(env);
    assert.equal(guard.calls.length, 0);
    assert.match(r.errors[0]!, /K1: keeper is a member/);
  });

  it("does not sync for such a Budget either: no signature means none", async (t) => {
    const { env, chain, guard } = setup(t);
    chain.views.get_policy = () => bytes({ roles: [{ kind: { Group: [KEEPER] } }] });
    guard.requests.push({ request_id: "plan-0-1", memo: "plan 0 run 1", proposal_id: 1, status: "AutoApproved", plan_id: 0, updated_at: "1" });
    guard.plan({ next_run_at: (headNs(HEAD) + HOUR_NS).toString() });
    await runKeeperJob(env);
    assert.equal(guard.calls.length, 0);
  });

  it("fails closed: a policy it cannot read means no signature", async (t) => {
    const { env, chain, guard } = setup(t);
    chain.views.get_policy = () => new Error("x");
    guard.plan();
    const r = await runKeeperJob(env);
    assert.equal(guard.calls.length, 0);
    assert.equal(r.errors.length, 1);
  });

  it("will not call a plan that pays the keeper itself", async (t) => {
    const { env, guard } = setup(t);
    guard.plan({ action: { type: "transfer", receiver_id: KEEPER } });
    guard.plan({ action: { type: "call", target: KEEPER, method: "m", args_base64: "", deposit: "0", gas: "1" } });
    guard.plan();
    const r = await runKeeperJob(env);
    assert.equal(r.errors.filter((e) => /K1: plan \d pays the keeper/.test(e)).length, 2);
    assert.deepEqual(guard.calls.filter((c) => c.method === "execute_plan_step").map((c) => c.args.plan_id), [2]);
  });
});

describe("GĐ29 keeper: messages (UC18)", () => {
  it("a three-run payout: three messages, each with its transaction, the last one the summary", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan();
    for (let i = 0; i < 3; i++) {
      await runKeeperJob(env);
      nextHour(chain);
    }
    const got = sends(chain);
    assert.equal(got.length, 3);
    assert.ok(got.every((m) => m.body.chat_id === CHAT));
    assert.match(String(got[0]!.body.text), /^Key Doctor · Scheduled payouts \(1\/3\)\nSent 1 NEAR to bob\.kd-demo\.testnet\.\nTotal spent: 1 NEAR\nNext run: /);
    assert.match(String(got[2]!.body.text), /Plan complete: 3\/3 runs, 3 NEAR spent in total\./);
    const hashes = rows(db, "SELECT tx_hash FROM plan_steps ORDER BY run").map((r) => r.tx_hash);
    assert.equal(hashes.length, 3);
    got.forEach((m, i) => {
      assert.deepEqual(buttons(m)[0], { text: "View transaction", url: `https://testnet.nearblocks.io/txns/${hashes[i]}` });
      assert.deepEqual(buttons(m)[1], { text: "Open Agent Budget", url: `https://dash.test/?page=budget&dao=${DAO}` });
    });
  });

  it("says each thing once: a quiet cycle after the plan ended sends and signs nothing", async (t) => {
    const { env, chain, guard } = setup(t);
    await watched(env, chain);
    guard.plan({ runs_total: 1 });
    await runKeeperJob(env);
    const before = guard.calls.length;
    const r = await runKeeperJob(env);
    assert.equal(r.steps_run, 0);
    assert.equal(guard.calls.length, before);
    assert.equal(sends(chain).length, 1);
  });

  it("carries both languages by default", async (t) => {
    const { env, chain, guard } = setup(t, undefined, { ALERT_LANG: "both" });
    await watched(env, chain);
    guard.plan();
    await runKeeperJob(env);
    const [text] = texts(chain);
    assert.match(text!, /Đã chuyển 1 NEAR/);
    assert.match(text!, /Sent 1 NEAR/);
  });

  it("a short Budget pauses with a Top up button, says so once, and a resume carries on at the same run", async (t) => {
    const { env, chain, guard } = setup(t);
    await watched(env, chain);
    const plan = guard.plan();
    await runKeeperJob(env); // run 1
    nextHour(chain);
    guard.next = "short";
    await runKeeperJob(env);
    await runKeeperJob(env);
    assert.equal(sends(chain).length, 2);
    const paused = sends(chain)[1]!;
    assert.match(String(paused.body.text), /Plan paused: the Budget is short of funds\.\n👉 Top up, then press Resume/);
    assert.deepEqual(buttons(paused).map((b) => b.text), ["View transaction", "Top up"]);

    plan.status = "active"; // the owner tops up and resumes
    plan.pause_reason = null;
    guard.next = "ok";
    await runKeeperJob(env);
    assert.match(texts(chain)[2]!, /Scheduled payouts \(2\/3\)/);
  });

  it("a skip tells why and costs nothing", async (t) => {
    const { env, chain, guard } = setup(t);
    await watched(env, chain);
    const plan = guard.plan();
    guard.next = "over_limit";
    await runKeeperJob(env);
    assert.match(texts(chain)[0]!, /Skipped this run: over the 24 h limit\. No money moved\./);
    assert.equal(plan.runs_done, 0);
  });

  it("a payment that fails at once is never announced as paid: the pause says so instead", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan();
    guard.syncFinds = "failed";
    await runKeeperJob(env);
    assert.equal(sends(chain).length, 0);
    await runKeeperJob(env);
    assert.deepEqual(rows(db, "SELECT status FROM plan_steps ORDER BY rowid").map((r) => r.status), ["executed", "failed"]);
    assert.equal(sends(chain).length, 1);
    assert.match(texts(chain)[0]!, /Plan paused: the step could not run \(PROPOSAL_FAILED\)\./);
  });

  it("a payment that fails after the message went out is corrected by the next sync", async (t) => {
    const { env, chain, guard } = setup(t);
    await watched(env, chain);
    guard.plan();
    guard.syncFinds = "open";
    await runKeeperJob(env);
    assert.match(texts(chain)[0]!, /\(1\/3\)/);
    guard.syncFinds = "failed";
    await runKeeperJob(env);
    await runKeeperJob(env);
    assert.equal(sends(chain).length, 2);
    assert.match(texts(chain)[1]!, /PROPOSAL_FAILED/);
  });

  it("a Telegram outage repeats the message on the next cycle instead of losing it", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan({ next_run_at: headNs(HEAD).toString() });
    chain.telegramStatus = 500;
    const failed = await runKeeperJob(env);
    assert.equal(failed.alerts_sent, 0);
    assert.equal(rows(db, "SELECT * FROM alerts_sent").length, 0);
    chain.telegramStatus = 200;
    assert.equal((await runKeeperJob(env)).alerts_sent, 1);
  });

  it("a chat that blocked the bot loses its subscription, as in the proposal job", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan();
    chain.telegramStatus = 403;
    await runKeeperJob(env);
    assert.equal(rows(db, "SELECT * FROM subscriptions").length, 0);
  });

  it("nobody watching: nothing is sent, and a later /watch does not replay the past", async (t) => {
    const { env, chain, guard } = setup(t);
    guard.plan();
    const r = await runKeeperJob(env);
    assert.equal(r.steps_run, 1);
    assert.equal(sends(chain).length, 0);
    await watched(env, chain);
    await runKeeperJob(env);
    assert.equal(sends(chain).length, 0);
  });

  it("without a bot token the messages wait instead of being written off as sent", async (t) => {
    const { env, chain, guard, db } = setup(t, undefined, { TELEGRAM_BOT_TOKEN: "" });
    guard.plan();
    await runKeeperJob(env);
    assert.equal(rows(db, "SELECT * FROM alerts_sent").length, 0);
    assert.equal(chain.telegram.length, 0);
  });
});

describe("GĐ29 keeper: its own balance (K4)", () => {
  it("warns the team once a day when the balance runs low, and keeps working", async (t) => {
    const { env, chain, guard } = setup(t);
    chain.balances[KEEPER] = (NEAR / 2n).toString();
    guard.plan();
    const r = await runKeeperJob(env);
    await runKeeperJob(env);
    const warnings = sends(chain).filter((m) => m.body.chat_id === TEAM);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]!.body.text), /holds 0\.5 NEAR, below the 1 NEAR minimum/);
    assert.equal(r.steps_run, 1);
  });

  it("warns above the maximum too: more money there means more to lose with the key", async (t) => {
    const { env, chain } = setup(t);
    chain.balances[KEEPER] = (6n * NEAR).toString();
    await runKeeperJob(env);
    assert.match(texts(chain)[0]!, /above the 5 NEAR maximum/);
  });

  it("says nothing inside the limits", async (t) => {
    const { env, chain } = setup(t);
    await runKeeperJob(env);
    assert.equal(sends(chain).length, 0);
  });

  it("a warning with nowhere to go is an error, not silence", async (t) => {
    const { env, chain } = setup(t, undefined, { KEEPER_ALERT_CHAT_ID: "" });
    chain.balances[KEEPER] = "1";
    const r = await runKeeperJob(env);
    assert.match(r.errors[0]!, /low_balance.*warning not sent/);
  });

  it("refuses limits that are not amounts rather than guess", async (t) => {
    const { env, chain } = setup(t, undefined, { KEEPER_MIN_BALANCE: "one" });
    const r = await runKeeperJob(env);
    assert.match(r.errors[0]!, /^KEEPER_BAD_BALANCE_LIMIT/);
    assert.equal(chain.calls.length, 0);
  });
});

describe("GĐ29 keeper: Worker limits and the key", () => {
  it("stays inside the 50 subrequests of the free plan on the busiest cycle, even if every chat has blocked the bot", async (t) => {
    const guards = [0, 1, 2].map((i) => new FakeGuard(`g${i}.kd-guards.testnet`, `d${i}.sputnik-dao.testnet`));
    const { env, chain, db } = setup(t, guards);
    chain.views.get_policy = () => bytes({ roles: [] });
    chain.balances[KEEPER] = "1"; // the balance warning spends subrequests as well
    chain.telegramStatus = 403; // each send then costs a delete too
    for (const [i, g] of guards.entries()) {
      await addSubscription(db, { target: g.dao_id, network: "testnet", target_type: "dao", chat_id: `-50${i}`, chat_type: "group", created_at: "2026-11-01T00:00:00.000Z" });
      g.paused = true; // read in every cycle, and a message of its own
      for (let p = 0; p < 2; p++) g.plan();
      // A backlog of unsaid steps with open syncs, each of which fails: the most work a cycle can find.
      for (let run = 1; run <= 8; run++) {
        g.requests.unshift({ request_id: `plan-0-${run}`, memo: `plan 0 run ${run}`, proposal_id: run, status: "AutoApproved", plan_id: 0, updated_at: headNs(HEAD).toString() });
      }
      const sync = g.sync.bind(g);
      g.sync = (id) => {
        g.syncFinds = "failed";
        return sync(id);
      };
    }
    chain.telegram.length = 0;
    chain.calls.length = 0;
    db.log.length = 0;
    const r = await runKeeperJob(env);
    assert.equal(r.steps_run, 3, "the case must really be the busiest");
    assert.equal(guards[0]!.calls.filter((c) => c.method === "sync_request").length, 2);
    assert.equal(sends(chain).length, 5, "the warning and four messages");
    const used = chain.calls.length + chain.telegram.length + db.log.length;
    assert.ok(used <= 50, `used ${used}: ${chain.calls.length} RPC, ${chain.telegram.length} Telegram, ${db.log.length} D1`);
  });

  it("never lets the key reach a result, a log or D1", async (t) => {
    const logged: string[] = [];
    for (const m of ["log", "error", "warn"] as const) t.mock.method(console, m, (...a: unknown[]) => void logged.push(JSON.stringify(a)));
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan();
    const seed = Buffer.from(base58Decode(SECRET.slice(8))).toString("hex");
    const good = await runKeeperJob(env);
    const bad = await runKeeperJob({ ...env, KEEPER_PRIVATE_KEY: `${SECRET}x` });
    const dump = JSON.stringify([good, bad, logged, chain.telegram, db.raw.prepare("SELECT * FROM plan_steps").all(), db.raw.prepare("SELECT * FROM alerts_sent").all()]);
    assert.ok(!dump.includes(SECRET.slice(8)));
    assert.ok(!dump.includes(seed));
  });

  it("the cron in wrangler.toml is the one the Worker listens for: a mismatch would run the proposal job instead", () => {
    const toml = readFileSync(join(import.meta.dirname, "..", "wrangler.toml"), "utf8");
    assert.ok(toml.includes(`"${KEEPER_CRON}"`));
  });

  it("runs from its cron and from /run-check, and only with the token", async (t) => {
    const { env, guard } = setup(t);
    guard.plan();
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron: KEEPER_CRON, scheduledTime: 0 }, env, { waitUntil: (p) => void pending.push(p) });
    await Promise.all(pending);
    assert.equal(guard.calls.filter((c) => c.method === "execute_plan_step").length, 1);

    const post = (token: string) =>
      worker.fetch(new Request("https://kd.test/run-check", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: '{"job":"keeper"}' }), env, { waitUntil: () => {} });
    assert.equal((await post("nope")).status, 401);
    const res = await post("run-token");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { job: string }).job, "keeper");
  });
});

describe("GD31 keeper: a DCA swap step (stepRecord, S3)", () => {
  const EX = "ref-finance-101.testnet";
  const SWAP = { type: "swap", pool_id: 57, token_out: "usdt.fakes.testnet", max_slippage_bps: 100 } as const;
  const TENTH = (NEAR / 10n).toString();
  const rhea = (out: string) => ({ outcome: { logs: [`Swapped ${TENTH} wrap.testnet for ${out} usdt.fakes.testnet`], executor_id: EX } });
  const dcaPlan = (g: FakeGuard, runs_total = 3) => g.plan({ action: SWAP, strategy_id: "dca-near", amount_per_run: TENTH, runs_total });

  /** What lands after the Guard's own receipt: the exchange's receipts, appended to the Guard's answer. */
  function withReceipts(chain: Chain, extra: (() => unknown[]) | null) {
    const inner = chain.sendTx!;
    chain.sendTx = (b64) => {
      const out = inner(b64) as { receipts_outcome: unknown[] };
      if (extra) out.receipts_outcome.push(...extra());
      return out;
    };
  }
  const saved = (db: TestD1) => rows(db, "SELECT status, result_json FROM plan_steps ORDER BY run").map((r) => ({ status: r.status, ...JSON.parse(r.result_json) }));

  it("an executed swap stores amount_out and the exact price, and the message and gas follow", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    dcaPlan(guard);
    withReceipts(chain, () => [rhea("896500")]);
    await runKeeperJob(env);
    const [s] = saved(db);
    assert.equal(s!.status, "executed");
    assert.equal(s!.amount_out, "896500");
    assert.equal(s!.price, "8.965");
    assert.equal(guard.calls[0]!.gas, 300n * 10n ** 12n, "a swap step chains 5 contracts: the cap, not 145 Tgas");
    // Telegram rendering of the swap message.
    const text = texts(chain)[0]!;
    assert.match(text, /^Key Doctor · DCA NEAR → USDT \(1\/3\)\nSold 0\.1 NEAR for 0\.8965 USDT · price 8\.965\nAverage price: 8\.965 · Received in total: 0\.8965 USDT\nNext run: /);
    assert.doesNotMatch(text, /balance/i);
    assert.equal(sends(chain).length, 1);
  });

  it("a Swapped log from a contract that is not the exchange is ignored: no number reaches the owner (forgery guard)", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    dcaPlan(guard);
    withReceipts(chain, () => [{ outcome: { logs: [`Swapped ${TENTH} wrap.testnet for 999999999 usdt.fakes.testnet`], executor_id: "evil.testnet" } }]);
    await runKeeperJob(env);
    const [s] = saved(db);
    assert.equal(s!.status, "executed");
    assert.equal(s!.amount_out, undefined);
    assert.equal(s!.price, undefined);
    assert.match(texts(chain)[0]!, /^Key Doctor · DCA NEAR → USDT \(1\/3\)\nSold 0\.1 NEAR for USDT\.\nTotal sold: 0\.1 NEAR\n/);
    assert.doesNotMatch(texts(chain)[0]!, /999|price/);
  });

  it("no exchange receipt yet: executed without amount_out, and a later run still has its own number", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    dcaPlan(guard);
    withReceipts(chain, null);
    await runKeeperJob(env);
    nextHour(chain);
    withReceipts(chain, () => [rhea("896500")]);
    await runKeeperJob(env);
    const got = saved(db);
    assert.deepEqual(got.map((s) => [s.status, s.amount_out]), [["executed", undefined], ["executed", "896500"]]);
    // Run 2's average divides by the NEAR of the run that has a number, not by both runs.
    assert.match(texts(chain)[1]!, /Average price: 8\.965 · Received in total: 0\.8965 USDT/);
  });

  it("a refused swap (E68) is stored skipped with SLIPPAGE and told once, with the NEAR still in the Budget", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    dcaPlan(guard);
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: E68: slippage error" } } } };
    withReceipts(chain, () => [{ outcome: { logs: [], executor_id: EX, status: { Failure: failure } } }]);
    await runKeeperJob(env);
    const [s] = saved(db);
    assert.equal(s!.status, "skipped");
    assert.equal(s!.reason, "SLIPPAGE");
    assert.equal(s!.amount_out, undefined);
    const told = texts(chain);
    assert.equal(told.length, 1, "one message for the run: the skip, not also a 'done'");
    assert.match(told[0]!, /Skipped this run: the price moved more than you allow\. 0\.1 NEAR stays in your Budget as wrapped NEAR\./);
    // A later cycle must not announce the same run as done either.
    await runKeeperJob(env);
    assert.equal(texts(chain).length, 1);
  });

  it("any other exchange failure is stored as SWAP_FAILED", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    dcaPlan(guard);
    withReceipts(chain, () => [{ outcome: { logs: [], executor_id: EX, status: { Failure: "E21: token not registered" } } }]);
    await runKeeperJob(env);
    assert.equal(saved(db)[0]!.reason, "SWAP_FAILED");
    assert.match(texts(chain)[0]!, /the exchange refused the swap\. 0\.1 NEAR stays/);
  });

  const SWAP_FLOOR = { ...SWAP, type: "swap_with_floor", min_out_per_near: "8500000" } as const;

  it("a swap_with_floor plan reads the exchange's receipt like an old swap plan (Guard 1.5.0, H2)", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan({ action: SWAP_FLOOR, strategy_id: "dca-near", amount_per_run: TENTH });
    withReceipts(chain, () => [rhea("896500")]);
    await runKeeperJob(env);
    const [s] = saved(db);
    assert.equal(s!.status, "executed");
    assert.equal(s!.amount_out, "896500");
    assert.equal(guard.calls[0]!.gas, 300n * 10n ** 12n, "a floored swap is still a 5-contract chain");
    assert.match(texts(chain)[0]!, /Sold 0\.1 NEAR for 0\.8965 USDT · price 8\.965/);
  });

  it("a price below the lowest price is stored skipped PRICE_BELOW_FLOOR and told as 'no money moved'", async (t) => {
    // WHY: a skewed pool must cost the owner nothing; the message must not claim wrapped NEAR is left over.
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    const plan = guard.plan({ action: SWAP_FLOOR, strategy_id: "dca-near", amount_per_run: TENTH });
    guard.next = "below_floor";
    await runKeeperJob(env);
    const [s] = saved(db);
    assert.equal(s!.status, "skipped");
    assert.equal(s!.reason, "PRICE_BELOW_FLOOR");
    assert.equal(plan.runs_done, 0);
    assert.match(texts(chain)[0]!, /Skipped this run: the price was below the lowest price you set\. No money moved\./);
  });

  it("an old swap plan pauses with PRICE_FLOOR_REQUIRED and tells the owner to recreate it, not to Resume", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan({ action: SWAP, strategy_id: "dca-near", amount_per_run: TENTH });
    guard.next = "floor_required";
    await runKeeperJob(env);
    const [s] = saved(db);
    assert.equal(s!.status, "failed");
    assert.equal(s!.reason, "PRICE_FLOOR_REQUIRED");
    const text = texts(chain)[0]!;
    assert.match(text, /Plan paused: it was made before the lowest-price rule, so it cannot run any more\./);
    assert.match(text, /Cancel it in Agent Budget and create it again with a lowest price\./);
    assert.doesNotMatch(text, /press Resume/);
    await runKeeperJob(env);
    assert.equal(sends(chain).length, 1, "a paused plan is not stepped or told again");
  });

  it("a plain transfer plan is not touched by swap parsing, even if the receipts carry an exchange failure", async (t) => {
    const { env, chain, guard, db } = setup(t);
    await watched(env, chain);
    guard.plan();
    withReceipts(chain, () => [{ outcome: { logs: [], executor_id: EX, status: { Failure: "E68" } } }]);
    await runKeeperJob(env);
    assert.equal(saved(db)[0]!.status, "executed");
  });
});
