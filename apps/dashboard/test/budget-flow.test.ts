import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BudgetFlowError,
  actProposalArgs,
  addRecipientProposal,
  confirmFirstSignature,
  confirmProposal,
  createPlanProposal,
  PAYOUT_STRATEGY,
  planChangeProposal,
  planFromForm,
  planTotals,
  proposalIdFromOutcome,
  sameProposal,
  outcomeFailed,
  voteResultText,
  withdrawProposal,
} from "../src/budget-flow.ts";
import { GUARD_FORM_TEXT, KEEPER_ACCOUNT } from "../src/guard-form.ts";

const outcomeWith = (n: number) => ({ status: { SuccessValue: btoa(JSON.stringify(n)) } });
const built = withdrawProposal("owner.testnet", "1000000000000000000000000", "1");
const onChain = (over: Record<string, unknown> = {}) => ({
  id: 7,
  status: "InProgress",
  description: built.description,
  // The chain's own shape, `msg: null` included (fixtures/sputnik/get_proposal.2.transfer.json).
  kind: { Transfer: { amount: "1000000000000000000000000", msg: null, receiver_id: "owner.testnet", token_id: "" } },
  ...over,
});

describe("proposalIdFromOutcome", () => {
  it("reads the id from the tx outcome's return value", () => {
    assert.equal(proposalIdFromOutcome(outcomeWith(7)), 7);
    assert.equal(proposalIdFromOutcome([outcomeWith(0)]), 0);
  });
  it("throws NO_PROPOSAL_ID when the wallet returned no outcome", () => {
    for (const bad of [undefined, null, [], {}, { status: { Failure: {} } }, { status: { SuccessValue: "" } }, { status: { SuccessValue: btoa('"x"') } }]) {
      assert.throws(() => proposalIdFromOutcome(bad), (e: unknown) => e instanceof BudgetFlowError && e.code === "NO_PROPOSAL_ID");
    }
  });
});

describe("sameProposal / confirmProposal", () => {
  it("matches whatever the key order", () => {
    assert.equal(sameProposal(built, onChain()), true);
  });
  it("confirms an open, identical proposal and returns the chain's kind for sign 2", async () => {
    const p = await confirmProposal(built, 7, async () => onChain());
    assert.equal(p.id, 7);
    assert.deepEqual(actProposalArgs(p, "VoteApprove"), { id: 7, action: "VoteApprove", proposal: onChain().kind });
  });
  it("stops sign 2 when the content differs (amount, receiver, description)", async () => {
    for (const over of [
      { kind: { Transfer: { token_id: "", receiver_id: "owner.testnet", amount: "2" } } },
      { kind: { Transfer: { token_id: "", receiver_id: "evil.testnet", amount: "1000000000000000000000000" } } },
      { description: "other" },
    ]) {
      await assert.rejects(confirmProposal(built, 7, async () => onChain(over)), (e: unknown) => e instanceof BudgetFlowError && e.code === "PROPOSAL_MISMATCH");
    }
  });
  it("stops when the proposal cannot be read, has another id, or is not open", async () => {
    await assert.rejects(confirmProposal(built, 7, async () => { throw new Error("rpc"); }), { code: "PROPOSAL_UNREADABLE" });
    await assert.rejects(confirmProposal(built, 7, async () => onChain({ id: 8 })), { code: "PROPOSAL_UNREADABLE" });
    await assert.rejects(confirmProposal(built, 7, async () => onChain({ status: "Approved" })), { code: "PROPOSAL_NOT_OPEN" });
  });
});

describe("confirmFirstSignature", () => {
  it("reads the id from the outcome, never from a last-id lookup", async () => {
    const asked: number[] = [];
    const p = await confirmFirstSignature(built, outcomeWith(7), async (id) => {
      asked.push(id);
      return onChain();
    });
    assert.deepEqual(asked, [7]);
    assert.equal(p.id, 7);
  });
  it("does not read the chain at all without an id", async () => {
    let reads = 0;
    await assert.rejects(confirmFirstSignature(built, undefined, async () => { reads += 1; return onChain(); }), { code: "NO_PROPOSAL_ID" });
    assert.equal(reads, 0);
  });
});

describe("adding a recipient", () => {
  const add = (v: Record<string, string>, existing: string[] = []) => addRecipientProposal("g.testnet", v, existing);
  const callArgs = (r: ReturnType<typeof add>) => {
    assert.ok(r.ok);
    const kind = r.value.proposal.kind as { FunctionCall: { actions: { method_name: string; args: string }[] } };
    return { method: kind.FunctionCall.actions[0]!.method_name, args: JSON.parse(atob(kind.FunctionCall.actions[0]!.args)) };
  };
  it("builds add_whitelist, and an empty limit means no limit of its own", () => {
    assert.deepEqual(callArgs(add({ account: " Vendor.testnet ", label: "Vendor" })), {
      method: "add_whitelist",
      args: { account_id: "vendor.testnet", label: "Vendor", max_per_tx: null },
    });
    assert.equal(callArgs(add({ account: "vendor.testnet", cap: "2" })).args.max_per_tx, `2${"0".repeat(24)}`);
  });
  it("never lets the keeper be a recipient: it signs for every Budget and would then be paid by them (ADR 0005 K1)", () => {
    assert.equal(add({ account: "keydoctor-keeper.testnet" }).ok, false);
  });
  it("refuses an account already listed: add_whitelist would silently replace its limit", () => {
    assert.equal(add({ account: "vendor.testnet" }, ["vendor.testnet"]).ok, false);
  });
  it("refuses a limit of 0: that reads as no spending but would be a recipient nobody can pay", () => {
    assert.equal(add({ account: "vendor.testnet", cap: "0" }).ok, false);
    assert.equal(add({ account: "vendor.testnet", cap: "abc" }).ok, false);
  });
  it("stops at the Guard's own list size, before two signatures are spent on a call that must fail", () => {
    assert.equal(add({ account: "vendor.testnet" }, Array.from({ length: 50 }, (_, i) => `r${i}.testnet`)).ok, false);
  });
});

describe("what a vote did", () => {
  const transfer = { Transfer: {} };
  const call = { FunctionCall: {} };
  it("says done only when the proposal really passed", () => {
    assert.match(voteResultText(7, "VoteApprove", transfer, "Approved"), /^Done: request #7 approved/);
    assert.match(voteResultText(7, "VoteReject", transfer, "Rejected"), /^Done: request #7 rejected/);
  });
  it("one vote of several is not an approval", () => {
    assert.doesNotMatch(voteResultText(7, "VoteApprove", transfer, "InProgress"), /Done|approved/);
  });
  it("a failed transfer is not reported as done", () => {
    assert.doesNotMatch(voteResultText(7, "VoteApprove", transfer, "Failed"), /Done/);
  });
  it("an approved call does not claim it worked: Sputnik shows Approved even when the Guard refused", () => {
    assert.doesNotMatch(voteResultText(7, "VoteApprove", call, "Approved"), /Done/);
    assert.match(voteResultText(7, "VoteApprove", call, "Approved"), /check it shows/);
  });
  it("an unreadable status claims nothing", () => {
    assert.doesNotMatch(voteResultText(7, "VoteApprove", transfer, null), /Done|approved/);
  });
  it("only a failed outcome counts as failed, no outcome stays unknown", () => {
    assert.equal(outcomeFailed({ status: { Failure: {} } }), true);
    assert.equal(outcomeFailed([{ status: { Failure: {} } }]), true);
    assert.equal(outcomeFailed({ status: { SuccessValue: "" } }), false);
    assert.equal(outcomeFailed(undefined), false);
  });
});

describe("scheduled payouts", () => {
  const NEAR = (n: number) => `${n}${"0".repeat(24)}`;
  const rules = {
    policy: { max_per_tx: NEAR(2), max_per_day: NEAR(5) },
    whitelist: [
      { account_id: "vendor.testnet", max_per_tx: null },
      { account_id: "small.testnet", max_per_tx: NEAR(1) },
      { account_id: KEEPER_ACCOUNT, max_per_tx: null },
    ],
  };
  const NOW = Date.UTC(2026, 10, 9, 12, 0);
  const form = (over: Record<string, string> = {}) => ({ receiver: "vendor.testnet", amount: "1", every: "1", unit: "hours", runs: "3", start: "", ...over });
  const refused = (over: Record<string, string>, r: Parameters<typeof planFromForm>[1] = rules) => {
    const result = planFromForm(form(over), r, NOW);
    assert.equal(result.ok, false, JSON.stringify(over));
    return result.ok ? "" : result.error;
  };

  it("a valid form becomes the PlanInput create_plan reads, amounts in yocto and start in ns", () => {
    const result = planFromForm(form({ amount: "0.5", every: "2", unit: "days" }), rules, NOW);
    assert.ok(result.ok);
    const args = createPlanProposal("g1.guards.testnet", result.value);
    const action = (args.proposal.kind.FunctionCall as { receiver_id: string; actions: { method_name: string; args: string; deposit: string }[] });
    assert.equal(action.receiver_id, "g1.guards.testnet");
    assert.equal(action.actions[0]!.method_name, "create_plan");
    // create_plan charges storage from the attached deposit; 0 would panic on the chain after the vote.
    assert.ok(BigInt(action.actions[0]!.deposit) > 0n);
    assert.deepEqual(JSON.parse(atob(action.actions[0]!.args)), {
      plan: {
        action: { type: "transfer", receiver_id: "vendor.testnet" },
        strategy_id: PAYOUT_STRATEGY,
        token_in: "",
        amount_per_run: "500000000000000000000000",
        interval_sec: 2 * 86_400,
        runs_total: 3,
        start_at: (BigInt(NOW) * 1_000_000n).toString(),
      },
    });
    assert.equal(result.value.starts_now, true);
  });

  it("refuses what the Guard's create_plan would refuse, since Sputnik would still show the failed call as Approved", () => {
    assert.match(refused({ receiver: "stranger.testnet" }), /recipient from your list/);
    assert.match(refused({ amount: "3" }), /per-request limit/);
    assert.match(refused({ receiver: "small.testnet", amount: "1.5" }), /this recipient's limit/);
    assert.match(refused({ amount: "2" }, { policy: { max_per_tx: NEAR(9), max_per_day: NEAR(1) }, whitelist: rules.whitelist }), /24-hour limit/);
    assert.match(refused({ amount: "0" }), /./);
    assert.match(refused({ every: "0", unit: "minutes" }), /at least 1 minute/);
    assert.match(refused({ every: "366", unit: "days" }), /365 days/);
    assert.match(refused({ runs: "0" }), /1 to 1000/);
    assert.match(refused({ runs: "1001" }), /1 to 1000/);
    assert.match(refused({ unit: "weeks" }), /whole number/);
    assert.match(refused({ start: "tomorrow" }), /date and time/);
  });

  it("refuses the keeper as recipient: it signs for every Budget, so no plan may pay it (ADR 0005 K1)", () => {
    assert.equal(refused({ receiver: KEEPER_ACCOUNT }), GUARD_FORM_TEXT.KEEPER_RECIPIENT.en);
  });

  it("does not check a plan against rules it could not read", () => {
    assert.match(refused({}, { policy: null, whitelist: rules.whitelist }), /Could not read/);
    assert.match(refused({}, { policy: rules.policy, whitelist: null }), /Could not read/);
  });

  it("a past start runs at once; a future one is kept", () => {
    const past = planFromForm(form({ start: "2020-01-01T00:00" }), rules, NOW);
    assert.ok(past.ok && past.value.start_ms === NOW && past.value.starts_now);
    const future = planFromForm(form({ start: "2027-01-01T09:30" }), rules, NOW);
    assert.ok(future.ok && future.value.start_ms === new Date("2027-01-01T09:30").getTime() && !future.value.starts_now);
  });

  it("totals are exact bigint sums and the shortfall never goes negative", () => {
    const plan = planFromForm(form({ amount: "0.1", runs: "1000", every: "1", unit: "hours" }), rules, NOW);
    assert.ok(plan.ok);
    const t = planTotals(plan.value, NEAR(30));
    assert.equal(t.total, NEAR(100));
    assert.equal(t.short, NEAR(70));
    assert.equal(t.partial, "0"); // 30 NEAR covers the next two 0.1 NEAR runs
    assert.equal(t.runs_per_day, 24);
    assert.equal(t.per_day, (24n * 10n ** 23n).toString());
    assert.equal(t.last_run_ms, NOW + 999 * 3_600_000);
    assert.equal(planTotals(plan.value, NEAR(500)).short, "0");
    assert.equal(planTotals(plan.value, null).short, null);
  });

  it("runs in one 24 hours: a 6-hour plan has 4, a daily plan 1, never more than the runs left", () => {
    const at = (every: string, unit: string, runs = "10") => {
      const p = planFromForm(form({ every, unit, runs, amount: "0.1" }), rules, NOW);
      assert.ok(p.ok);
      return planTotals(p.value, null).runs_per_day;
    };
    assert.equal(at("6", "hours"), 4);
    assert.equal(at("1", "days"), 1);
    assert.equal(at("1", "minutes", "3"), 3);
  });

  it("pause, resume and cancel name the plan; anything else builds nothing", () => {
    for (const [op, method] of [["pause", "pause_plan"], ["resume", "resume_plan"], ["cancel", "cancel_plan"]] as const) {
      const p = planChangeProposal("g1.guards.testnet", op, 4);
      const a = (p?.proposal.kind.FunctionCall as { actions: { method_name: string; args: string; deposit: string }[] }).actions[0]!;
      assert.equal(a.method_name, method);
      assert.deepEqual(JSON.parse(atob(a.args)), { plan_id: 4 });
      assert.equal(a.deposit, "0");
    }
    assert.equal(planChangeProposal("g1.guards.testnet", "delete", 4), null);
    assert.equal(planChangeProposal("g1.guards.testnet", "pause", Number.NaN), null);
  });
});
