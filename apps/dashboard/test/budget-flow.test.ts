import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BudgetFlowError,
  actProposalArgs,
  addRecipientProposal,
  confirmFirstSignature,
  confirmProposal,
  proposalIdFromOutcome,
  sameProposal,
  outcomeFailed,
  voteResultText,
  withdrawProposal,
} from "../src/budget-flow.ts";

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
