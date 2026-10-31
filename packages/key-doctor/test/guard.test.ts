import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { guardVerdict, scanAccount, type Flag, type KdReport } from "../src/index.ts";
import { MEMBER_ERROR_TEXT } from "../src/messages.ts";
import { FIXTURES, installStub, type Answer } from "./stub-rpc.ts";

const load = (rel: string): KdReport => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as KdReport;
const accountB = () => load("reports/account-b.report.json");

async function scanCorpus(file: string): Promise<KdReport> {
  const c = JSON.parse(readFileSync(join(FIXTURES, "corpus", file), "utf8")) as { target: string; responses: Record<string, Answer> };
  const stub = installStub(c.responses);
  try {
    return await scanAccount(c.target);
  } finally {
    stub.restore();
  }
}

describe("guardVerdict: one verdict an agent can gate a payment on", () => {
  it("block: a full-access key added inside the 48 h window is a takeover sign, so the agent must not sign", async () => {
    const g = guardVerdict(await scanCorpus("FA_RECENT.pos.json"));
    assert.equal(g.schema_version, "kd.guard.v1");
    assert.equal(g.verdict, "block");
    assert.equal(g.account.id, "fa-recent-pos.kd-corpus.testnet");
    assert.equal(g.reasons[0]?.code, "FA_RECENT");
    assert.equal(g.reasons[0]?.severity, "high");
    assert.ok(g.reasons[0]?.public_key?.startsWith("ed25519:"));
    assert.match(g.reasons[0]!.messages.en, /^New full-access key\. This full-access key was added/);
    assert.match(g.reasons[0]!.messages.vi, /^Khóa toàn quyền mới thêm\./);
  });

  it("one block outside the window the same key no longer blocks", async () => {
    assert.notEqual(guardVerdict(await scanCorpus("FA_RECENT.neg.json")).verdict, "block");
  });

  it("review: cleanup flags need a human look but are not a takeover sign; notes stay out of reasons", () => {
    const g = guardVerdict(accountB());
    assert.equal(g.verdict, "review");
    assert.deepEqual(g.reasons.map((r) => r.code), ["FC_UNLIMITED_ALLOWANCE", "FC_ANY_METHOD"]);
    assert.deepEqual(g.account.flags, ["FC_UNLIMITED_ALLOWANCE", "FC_ANY_METHOD", "PQ_NONE"]);
    assert.equal(g.account.status, "cleanup");
    assert.equal(g.block_height, accountB().chain.block_height);
    assert.equal(g.ruleset_version, accountB().ruleset_version);
    assert.equal(g.network, "testnet");
  });

  it("FA_MANY alone is review, not block: many full-access keys are common on normal accounts", () => {
    const r = accountB();
    const many: Flag = { ...r.members[0]!.flags[0]!, rule_id: "FA_MANY", severity: "high", scope: "account" };
    r.members[0]!.flags = [many];
    assert.equal(guardVerdict(r).verdict, "review");
  });

  it("allow: notes only", () => {
    const r = accountB();
    r.members[0]!.flags = r.members[0]!.flags.filter((f) => f.severity === "note");
    const g = guardVerdict(r);
    assert.equal(g.verdict, "allow");
    assert.deepEqual(g.reasons, []);
    assert.deepEqual(g.account.flags, ["PQ_NONE"]);
  });

  it("keys that could not be read are review, never allow: the risk is unknown, not low", () => {
    const r = accountB();
    r.members[0]!.flags = [];
    r.members[0]!.error = "RATE_LIMITED";
    const g = guardVerdict(r);
    assert.equal(g.verdict, "review");
    assert.deepEqual(g.reasons, [{ code: "RATE_LIMITED", severity: "high", messages: MEMBER_ERROR_TEXT.RATE_LIMITED }]);
    assert.equal(g.account.error, "RATE_LIMITED");
  });

  it("is pure and refuses a DAO report", () => {
    const r = accountB();
    const before = JSON.stringify(r);
    assert.deepEqual(guardVerdict(r), guardVerdict(r));
    assert.equal(JSON.stringify(r), before);
    assert.throws(() => guardVerdict(load("reports/dao-kd-demo.report.json")), /one account/);
  });
});
