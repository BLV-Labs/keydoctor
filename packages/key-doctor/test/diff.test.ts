import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { diffReports, toSummary, type Flag, type KdReport, type KeyInfo, type Member } from "../src/index.ts";

const load = (rel: string): KdReport =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", rel), "utf8")) as KdReport;
const dao = () => load("reports/dao-kd-demo.report.json");
const later = (r: KdReport, blocks = 72_000): KdReport => ({
  ...r,
  generated_at: "2026-11-04T02:00:12Z",
  chain: { ...r.chain, block_height: r.chain.block_height + blocks },
});
const member = (r: KdReport, id: string): Member => {
  const m = r.members.find((x) => x.account_id === id);
  assert.ok(m, id);
  return m;
};
const A = "a.kd-demo.testnet";
const B = "b.kd-demo.testnet";
const C = "c.kd-demo.testnet";

const faKey = (pk: string, flags: string[] = []): KeyInfo => ({
  public_key: pk,
  curve: "ed25519",
  permission: { type: "full_access" },
  nonce: "182400000000000",
  use_count: 0,
  created: { block_height: 182400000, at: "2026-11-03T22:00:00Z", source: "nonce_estimate" },
  age_days: 0,
  flag_ids: flags,
});

const flag = (rule_id: string, severity: Flag["severity"], account_id: string, public_key?: string): Flag => ({
  rule_id,
  severity,
  scope: public_key ? "key" : "account",
  account_id,
  ...(public_key && { public_key }),
  evidence: {},
  messages: {
    vi: { title: `vi ${rule_id}`, explain: "", fix: "" },
    en: { title: `en ${rule_id}`, explain: "", fix: "" },
  },
});

describe("GĐ2 diffReports: baseline and no change", () => {
  it("prev = null is the baseline: no changes, the unseen-key limitation, baseline_updated false", () => {
    const d = diffReports(null, dao());
    assert.equal(d.schema_version, "kd.diff.v1");
    assert.equal(d.is_baseline, true);
    assert.equal(d.baseline_updated, false);
    assert.equal(d.from, null);
    assert.deepEqual(d.changes, []);
    assert.equal(d.summary.has_changes, false);
    assert.equal(d.summary.highest_severity, null);
    assert.equal(d.summary.status_before, null);
    assert.equal(d.summary.status_after, "high");
    assert.deepEqual(d.limitations, ["A key added and removed between two scans is not seen."]);
  });

  it("the same chain state a day later has no changes", () => {
    const prev = dao();
    const d = diffReports(prev, later(dao()));
    assert.equal(d.is_baseline, false);
    assert.deepEqual(d.from, { generated_at: prev.generated_at, block_height: prev.chain.block_height });
    assert.equal(d.to.block_height, prev.chain.block_height + 72_000);
    assert.equal(d.summary.has_changes, false);
    assert.deepEqual(d.summary.counts, {});
    assert.ok(d.limitations.includes("A key added and removed between two scans is not seen."));
  });

  it("is pure: inputs are not mutated and the result is deterministic", () => {
    const prev = dao();
    const curr = later(dao());
    member(curr, B).keys.push(faKey("ed25519:NewKey111"));
    const snapshot = JSON.stringify([prev, curr]);
    const d1 = diffReports(prev, curr);
    const d2 = diffReports(prev, curr);
    assert.equal(JSON.stringify([prev, curr]), snapshot);
    assert.deepEqual(d1, d2);
  });

  it("refuses reports for different targets or networks", () => {
    const other = { ...dao(), target: { type: "dao" as const, id: "other.sputnik-v2.testnet" } };
    assert.throws(() => diffReports(dao(), other), /different targets/);
    const mainnet = { ...dao(), chain: { ...dao().chain, network: "mainnet" as const } };
    assert.throws(() => diffReports(dao(), mainnet), /different targets/);
  });
});

describe("GĐ2 diffReports: keys", () => {
  it("a new full-access key is high, and its flags rise with the rule severity", () => {
    const prev = dao();
    const curr = later(dao());
    const b = member(curr, B);
    b.keys.push(faKey("ed25519:NewKey111", ["FA_MULTIPLE", "KEY_UNUSED"]));
    b.flags.push(flag("FA_MULTIPLE", "cleanup", B), flag("KEY_UNUSED", "cleanup", B, "ed25519:NewKey111"));
    const d = diffReports(prev, curr);
    const first = d.changes[0];
    assert.equal(first?.type, "key_added");
    assert.equal(first?.severity, "high");
    assert.equal(first?.account_id, B);
    assert.equal(first?.public_key, "ed25519:NewKey111");
    assert.match(first?.messages.en ?? "", /new full-access key/);
    assert.ok(first?.messages.vi);
    assert.equal(d.summary.highest_severity, "high");
    assert.equal(d.summary.counts.key_added, 1);
    assert.equal(d.summary.counts.flag_raised, 2);
    assert.ok(d.changes.filter((c) => c.type === "flag_raised").every((c) => c.severity === "cleanup"));
  });

  it("a new app key is note, unless it matches FC_DAO_VOTE (high)", () => {
    const prev = dao();
    const curr = later(dao());
    const appKey = (pk: string, flags: string[]): KeyInfo => ({
      ...faKey(pk, flags),
      permission: { type: "function_call", receiver_id: "game.kd-demo.testnet", method_names: ["play"], allowance_yocto: "1" },
    });
    member(curr, C).keys.push(appKey("ed25519:App1", []), appKey("ed25519:Vote1", ["FC_DAO_VOTE"]));
    const d = diffReports(prev, curr);
    const vote = d.changes.find((c) => c.public_key === "ed25519:Vote1");
    const app = d.changes.find((c) => c.public_key === "ed25519:App1");
    assert.equal(vote?.severity, "high");
    assert.equal(vote?.rule_id, "FC_DAO_VOTE");
    assert.equal(app?.severity, "note");
    assert.match(app?.messages.en ?? "", /new app key for game\.kd-demo\.testnet/);
  });

  it("a removed key is note, and the flags it carried are cleared", () => {
    const prev = dao();
    const curr = later(dao());
    const a = member(curr, A);
    const gone = "ed25519:zsNxJRqtpFdNtZhWDw2v1nNT419ozWMtpKi24cxgFW3";
    a.keys = a.keys.filter((k) => k.public_key !== gone);
    a.flags = a.flags.filter((f) => f.public_key !== gone);
    const d = diffReports(prev, curr);
    const removed = d.changes.find((c) => c.type === "key_removed");
    assert.equal(removed?.severity, "note");
    assert.equal(removed?.public_key, gone);
    assert.match(removed?.messages.en ?? "", /full-access key of a\.kd-demo\.testnet was removed/);
    const cleared = d.changes.filter((c) => c.type === "flag_cleared");
    assert.deepEqual(cleared.map((c) => c.rule_id), ["KEY_UNUSED"]);
    assert.equal(cleared[0]?.severity, "note");
    assert.deepEqual(cleared[0]?.details, { severity_before: "cleanup" });
  });

  it("the same public key with a new permission counts as removed and added", () => {
    const prev = dao();
    const curr = later(dao());
    const b = member(curr, B);
    const app = b.keys.find((k) => k.permission.type === "function_call");
    assert.ok(app);
    app.permission = { type: "full_access" };
    const d = diffReports(prev, curr);
    assert.equal(d.summary.counts.key_added, 1);
    assert.equal(d.summary.counts.key_removed, 1);
    assert.equal(d.changes[0]?.severity, "high");
  });
});

describe("GĐ2 diffReports: members, roles, PQ", () => {
  it("member added and removed are note", () => {
    const prev = dao();
    const curr = later(dao());
    const c = member(curr, C);
    curr.members = curr.members.filter((m) => m.account_id !== C);
    curr.members.push({ ...c, account_id: "d.kd-demo.testnet" });
    const d = diffReports(prev, curr);
    assert.deepEqual(
      d.changes.map((x) => [x.type, x.account_id, x.severity]),
      [
        ["member_added", "d.kd-demo.testnet", "note"],
        ["member_removed", C, "note"],
      ],
    );
    assert.deepEqual(d.changes[0]?.details, { roles: ["council"], status: "ok" });
  });

  it("role change is note, and high when the member becomes an admin", () => {
    const prev = dao();
    const curr = later(dao());
    member(curr, C).roles = ["council", "auditors"];
    const b = member(curr, B);
    b.roles = ["council", "admins"];
    b.flags.push(flag("DAO_ADMIN", "high", B));
    const d = diffReports(prev, curr);
    const roles = d.changes.filter((c) => c.type === "role_changed");
    assert.deepEqual(roles.map((c) => [c.account_id, c.severity]), [
      [B, "high"],
      [C, "note"],
    ]);
    assert.deepEqual(roles[1]?.details, { roles_before: ["council"], roles_after: ["council", "auditors"] });
    assert.equal(d.changes.find((c) => c.type === "flag_raised")?.rule_id, "DAO_ADMIN");
  });

  it("role order alone is not a change", () => {
    const prev = dao();
    member(prev, A).roles = ["council", "x"];
    const curr = later(dao());
    member(curr, A).roles = ["x", "council"];
    assert.equal(diffReports(prev, curr).summary.has_changes, false);
  });

  it("pq_ready change is note in both directions", () => {
    const prev = dao();
    const curr = later(dao());
    member(curr, C).pq_ready = false;
    member(curr, A).pq_ready = true;
    const d = diffReports(prev, curr);
    const pq = d.changes.filter((c) => c.type === "pq_ready_changed");
    assert.deepEqual(pq.map((c) => [c.account_id, c.messages.en]), [
      [A, `${A} is now quantum-ready.`],
      [C, `${C} is no longer quantum-ready.`],
    ]);
    assert.ok(pq.every((c) => c.severity === "note"));
  });
});

describe("GĐ2 diffReports: skips", () => {
  it("a member with an error in either report is skipped and named in limitations", () => {
    for (const side of ["prev", "curr"] as const) {
      const prev = dao();
      const curr = later(dao());
      member(curr, A).keys.push(faKey("ed25519:Hidden"));
      const broken = member(side === "prev" ? prev : curr, A);
      broken.error = "RPC_ERROR";
      broken.keys = side === "prev" ? [] : broken.keys;
      const d = diffReports(prev, curr);
      assert.ok(!d.changes.some((c) => c.account_id === A), side);
      assert.ok(d.limitations.some((l) => l.startsWith(`${A} could not be read`)), side);
    }
  });

  it("a different ruleset_version compares keys and members but not flags", () => {
    const prev = dao();
    const curr = { ...later(dao()), ruleset_version: "2026-12-01" };
    const b = member(curr, B);
    b.keys.push(faKey("ed25519:NewKey111"));
    b.flags.push(flag("FA_MULTIPLE", "cleanup", B));
    member(curr, A).flags = [];
    const d = diffReports(prev, curr);
    assert.deepEqual(d.changes.map((c) => c.type), ["key_added"]);
    assert.ok(d.limitations.includes("The ruleset changed from 2026-11-01 to 2026-12-01; flag changes are not compared."));
  });

  it("DAO-level flags are compared under the DAO id", () => {
    const prev = dao();
    const curr = later(dao());
    curr.dao_flags = [flag("COUNCIL_SMALL", "high", undefined as unknown as string)];
    delete curr.dao_flags[0]!.account_id;
    const d = diffReports(prev, curr);
    assert.deepEqual(d.changes.map((c) => [c.type, c.account_id, c.rule_id, c.severity]), [
      ["flag_raised", "kd-demo.sputnik-dao.testnet", "COUNCIL_SMALL", "high"],
    ]);
  });

  it("changes are sorted by severity, then type, then account", () => {
    const prev = dao();
    const curr = later(dao());
    member(curr, C).pq_ready = false;
    member(curr, B).keys.push(faKey("ed25519:NewKey111"));
    member(curr, A).roles = ["council", "x"];
    const d = diffReports(prev, curr);
    assert.deepEqual(d.changes.map((c) => c.type), ["key_added", "role_changed", "pq_ready_changed"]);
    assert.equal(d.summary.status_before, "high");
  });
});

describe("GĐ2 toSummary", () => {
  it("drops keys, keeps everything else, and does not mutate the report", () => {
    const r = dao();
    const before = JSON.stringify(r);
    const s = toSummary(r);
    assert.equal(JSON.stringify(r), before);
    assert.equal(s.schema_version, "kd.report_summary.v1");
    assert.equal(s.members.length, r.members.length);
    for (const [i, m] of s.members.entries()) {
      assert.ok(!("keys" in m));
      const { keys: _k, ...rest } = r.members[i] as Member;
      assert.deepEqual(m, rest);
    }
    const { schema_version: _a, members: _b, ...reportRest } = r;
    const { schema_version: _c, members: _d, ...summaryRest } = s;
    assert.deepEqual(summaryRest, reportRest);
    s.summary.status = "ok";
    assert.equal(r.summary.status, "high");
  });

  it("an account report keeps its one member", () => {
    const r = load("reports/account-b.report.json");
    const s = toSummary(r);
    assert.deepEqual(s.members.map((m) => m.account_id), ["b.kd-demo.testnet"]);
    assert.equal(s.members[0]?.flags.length, r.members[0]?.flags.length);
  });
});
