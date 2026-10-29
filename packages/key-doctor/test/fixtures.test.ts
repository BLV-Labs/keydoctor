import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import type { KdAlert, KdReport, Severity, Status } from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const load = <T>(rel: string): T => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;

function listJson(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listJson(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : [],
  );
}

const reportFiles = readdirSync(join(FIXTURES, "reports")).map((f) => `reports/${f}`);
const RANK: Record<Status, number> = { ok: 0, note: 1, cleanup: 2, high: 3 };
const SEVERITIES: Severity[] = ["high", "cleanup", "note"];

describe("fixtures: privacy", () => {
  // CLAUDE.md: never use real mainnet DAO or account names in fixtures.
  for (const file of listJson(FIXTURES)) {
    it(`${relative(FIXTURES, file)} uses testnet names only`, () => {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /[a-z0-9_-]\.near\b/);
      assert.doesNotMatch(text, /"mainnet"/);
    });
  }
});

for (const file of reportFiles) {
  describe(`kd.report.v1 fixture ${file}`, () => {
    const r = load<KdReport>(file);
    const keys = r.members.flatMap((m) => m.keys);

    it("has the contract header", () => {
      assert.equal(r.schema_version, "kd.report.v1");
      assert.match(r.ruleset_version, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(!Number.isNaN(Date.parse(r.generated_at)));
      assert.equal(r.chain.network, "testnet");
    });

    it("an account report has exactly one member and no dao block", () => {
      if (r.target.type !== "account") return;
      assert.equal(r.members.length, 1);
      assert.equal(r.dao, undefined);
    });

    it("summary counts match the members", () => {
      assert.equal(r.summary.members_scanned, r.members.length);
      assert.equal(r.summary.members_high, r.members.filter((m) => m.status === "high").length);
      assert.equal(r.summary.members_cleanup, r.members.filter((m) => m.status === "cleanup").length);
      assert.equal(r.summary.members_ok, r.members.filter((m) => m.status === "ok").length);
      assert.equal(r.summary.pq_ready, r.members.filter((m) => m.pq_ready).length);
      assert.equal(r.summary.keys_total, keys.length);
      assert.equal(r.summary.keys_full_access, keys.filter((k) => k.permission.type === "full_access").length);
      assert.equal(r.summary.keys_unused, keys.filter((k) => k.use_count === 0).length);
    });

    it("member status is not above its highest flag severity", () => {
      for (const m of r.members) {
        const highest = m.flags.reduce<Status>((s, f) => (RANK[f.severity] > RANK[s] ? f.severity : s), "ok");
        assert.ok(RANK[m.status] <= RANK[highest], `${m.account_id}: ${m.status} > ${highest}`);
        if (highest === "high" || highest === "cleanup") assert.equal(m.status, highest);
      }
    });

    it("report status is the worst member status", () => {
      const worst = r.members.reduce<Status>((s, m) => (RANK[m.status] > RANK[s] ? m.status : s), "ok");
      assert.equal(r.summary.status, worst);
    });

    it("key age fields follow the nonce rule", () => {
      for (const k of keys) {
        if (k.created.source !== "nonce_estimate") continue;
        const nonce = BigInt(k.nonce);
        assert.equal(k.created.block_height, Number(nonce / 1_000_000n));
        assert.equal(k.use_count, Number(nonce % 1_000_000n));
      }
    });

    it("every key flag id points at a flag of that member", () => {
      for (const m of r.members) {
        const ruleIds = new Set(m.flags.map((f) => f.rule_id));
        for (const k of m.keys) for (const id of k.flag_ids) assert.ok(ruleIds.has(id), `${m.account_id}: ${id}`);
      }
    });

    it("every flag has a known severity and vi + en messages", () => {
      for (const f of [...r.members.flatMap((m) => m.flags), ...r.dao_flags]) {
        assert.ok(SEVERITIES.includes(f.severity));
        for (const lang of ["vi", "en"] as const) {
          assert.notEqual(f.messages[lang].title, "");
          assert.notEqual(f.messages[lang].explain, "");
          assert.notEqual(f.messages[lang].fix, "");
        }
      }
    });

    it("yoctoNEAR amounts are digit strings", () => {
      if (r.dao) assert.match(r.dao.proposal_bond_yocto, /^\d+$/);
      for (const k of keys) {
        if (k.permission.type === "function_call" && k.permission.allowance_yocto !== null) {
          assert.match(k.permission.allowance_yocto, /^\d+$/);
        }
      }
    });
  });
}

describe("kd.alert.v1 fixture", () => {
  const a = load<KdAlert>("alerts/voter-new-full-access-key.alert.json");

  it("alert_id follows {network}:{target}:{kind}:{proposal_id}:{account_id}", () => {
    assert.equal(a.alert_id, `${a.network}:${a.target}:${a.kind}:${a.proposal?.id}:${a.evidence?.account_id}`);
  });

  it("names the pending voters and carries vi + en text", () => {
    const voter = a.evidence?.account_id ?? "";
    assert.ok((a.proposal?.pending_voters.length ?? 0) > 0);
    assert.ok(!a.proposal?.pending_voters.includes(voter));
    for (const lang of ["vi", "en"] as const) {
      assert.notEqual(a.messages[lang].title, "");
      assert.ok(a.messages[lang].body.includes(voter));
      assert.notEqual(a.messages[lang].action, "");
    }
  });

  it("evidence key block matches the voter's key in the DAO report", () => {
    const r = load<KdReport>("reports/dao-kd-demo.report.json");
    const key = r.members.flatMap((m) => m.keys).find((k) => k.public_key === a.evidence?.public_key);
    assert.equal(key?.permission.type, "full_access");
    assert.equal(key?.created.block_height, a.evidence?.key_added_block);
  });
});

describe("Sputnik fixtures", () => {
  it("get_proposal fixtures carry the fields checkProposals reads", () => {
    for (const f of ["sputnik/get_proposal.2.transfer.json", "sputnik/get_proposal.3.add_member.json"]) {
      const p = load<Record<string, unknown>>(f);
      for (const field of ["id", "proposer", "description", "kind", "status", "votes", "submission_time"]) {
        assert.ok(field in p, `${f}: missing ${field}`);
      }
    }
  });
});
