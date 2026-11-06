import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetAlerts, type BudgetAlertInput, type Plan, type PlanRequest, type PlanStepRecord } from "../src/index.ts";

const NEAR = 10n ** 24n;
const DAO = "payroll.sputnik-v2.testnet";
const GUARD = "payroll.keydoctor-guards-v2.testnet";
const T0 = 1_793_000_000_000_000_000n;
const HOUR = 3_600_000_000_000n;
const slot = (n: number) => (T0 + BigInt(n) * HOUR).toString();

const plan = (over: Partial<Plan> = {}): Plan => ({
  plan_id: 0,
  action: { type: "transfer", receiver_id: "bob.kd-demo.testnet" },
  strategy_id: "scheduled-payouts",
  token_in: "",
  amount_per_run: NEAR.toString(),
  interval_sec: 3600,
  runs_total: 3,
  runs_done: 1,
  start_at: slot(0),
  next_run_at: slot(1),
  status: "active",
  pause_reason: null,
  ...over,
});
const request = (run: number, status = "AutoApproved", due = run - 1): PlanRequest => ({
  request_id: `plan-0-${slot(due)}`,
  memo: `plan 0 run ${run}`,
  proposal_id: run + 10,
  status,
  plan_id: 0,
  updated_at: slot(due),
});
const row = (run: number, over: Partial<PlanStepRecord> = {}): PlanStepRecord => ({
  plan_id: 0,
  run,
  status: "executed",
  amount_in: NEAR.toString(),
  tx_hash: `hash${run}`,
  executed_at: "2026-11-06T00:00:00.000Z",
  due: slot(run - 1),
  ...over,
});
const alerts = (over: Partial<BudgetAlertInput>) =>
  budgetAlerts({
    network: "testnet",
    budget: { dao_id: DAO, guard_id: GUARD },
    plans: [plan()],
    requests: [],
    steps: [],
    now: "2026-11-06T00:00:00.000Z",
    dashboardUrl: "https://dash.test/",
    ...over,
  });

describe("budgetAlerts", () => {
  it("a three-run plan gives exactly three messages, each with its transaction, and the last is the summary (UC18)", () => {
    const done = plan({ runs_done: 3, status: "completed", next_run_at: null });
    const got = alerts({ plans: [done], requests: [request(3), request(2), request(1)], steps: [row(1), row(2), row(3)] });
    assert.deepEqual(got.map((a) => a.kind), ["plan_step_executed", "plan_step_executed", "plan_completed"]);
    assert.deepEqual(got.map((a) => a.links.tx), [1, 2, 3].map((n) => `https://testnet.nearblocks.io/txns/hash${n}`));
    assert.match(got[2]!.messages.en.body, /3\/3 runs, 3 NEAR spent/);
    assert.match(got[2]!.messages.vi.body, /Kế hoạch hoàn tất/);
  });

  it("only a plain step can be muted, and only a pause is high (§9.5)", () => {
    const [step] = alerts({ requests: [request(1)] });
    assert.equal(step!.muteable, true);
    assert.equal(step!.severity, "note");
    const [paused] = alerts({ plans: [plan({ status: "paused", pause_reason: "insufficient_balance" })] });
    assert.equal(paused!.muteable, false);
    assert.equal(paused!.severity, "high");
  });

  it("still reports a step another caller ran, without inventing a transaction: the keeper is not the only caller (K2)", () => {
    const [a] = alerts({ requests: [request(1)] });
    assert.equal(a!.kind, "plan_step_executed");
    assert.equal(a!.links.tx, undefined);
    assert.equal(a!.step?.proposal_id, 11);
    assert.equal(a!.links.dashboard, `https://dash.test/?page=budget&dao=${DAO}`);
  });

  it("says nothing for a step that failed or never got approved", () => {
    assert.deepEqual(alerts({ requests: [request(1, "Failed"), request(1, "Submitted"), request(1, "Rejected")] }), []);
  });

  it("ignores requests of agents, which are not plan steps", () => {
    assert.deepEqual(alerts({ requests: [{ ...request(1), request_id: "inv-001", memo: "invoice", plan_id: null }] }), []);
  });

  it("a run retried after its first try failed gets its own message: the same run number must not dedupe it", () => {
    const first = alerts({ requests: [request(2, "AutoApproved", 1)] })[0]!;
    const retry = alerts({ requests: [request(2, "AutoApproved", 2)] })[0]!;
    assert.notEqual(first.alert_id, retry.alert_id);
  });

  it("two skips of one run are two messages, because a skip keeps the run", () => {
    const skips = [row(2, { status: "skipped", reason: "OVER_DAILY_LIMIT", due: slot(1) }), row(2, { status: "skipped", reason: "OVER_DAILY_LIMIT", due: slot(2), tx_hash: "x" })];
    const got = alerts({ steps: skips });
    assert.equal(new Set(got.map((a) => a.alert_id)).size, 2);
    assert.equal(got[0]!.kind, "plan_step_skipped");
    assert.match(got[0]!.messages.en.body, /over the 24 h limit\. No money moved\./);
  });

  it("a second pause at the same run is a new message, or a resumed plan could stop in silence", () => {
    const paused = plan({ status: "paused", pause_reason: "guard_low_near" });
    const failure = (hash: string) => row(2, { status: "failed", reason: "INSUFFICIENT_GUARD_BALANCE", tx_hash: hash });
    const once = alerts({ plans: [paused], steps: [failure("a")] })[0]!;
    const twice = alerts({ plans: [paused], steps: [failure("a"), failure("b")] })[0]!;
    assert.notEqual(once.alert_id, twice.alert_id);
    assert.equal(twice.links.tx, "https://testnet.nearblocks.io/txns/b");
    assert.equal(alerts({ plans: [paused], steps: [failure("a")] })[0]!.alert_id, once.alert_id);
  });

  it("a pause tells the owner what to do by its cause", () => {
    const text = (pause_reason: Plan["pause_reason"]) => alerts({ plans: [plan({ status: "paused", pause_reason })] })[0]!.messages.en;
    assert.match(text("insufficient_balance").action, /^Top up, then press Resume/);
    assert.match(text("guard_low_near").action, /^Top up the Guard/);
    assert.match(text("failures").action, /review the rules/);
  });

  it("a pause the owner chose is no news to the owner", () => {
    assert.deepEqual(alerts({ plans: [plan({ status: "paused", pause_reason: "owner" })] }), []);
  });
});
