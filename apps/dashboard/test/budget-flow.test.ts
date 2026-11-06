import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BudgetFlowError,
  actProposalArgs,
  confirmFirstSignature,
  confirmProposal,
  proposalIdFromOutcome,
  sameProposal,
  withdrawProposal,
} from "../src/budget-flow.ts";

const outcomeWith = (n: number) => ({ status: { SuccessValue: btoa(JSON.stringify(n)) } });
const built = withdrawProposal("owner.testnet", "1000000000000000000000000", "1");
const onChain = (over: Record<string, unknown> = {}) => ({
  id: 7,
  status: "InProgress",
  description: built.description,
  kind: { Transfer: { amount: "1000000000000000000000000", receiver_id: "owner.testnet", token_id: "" } },
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
