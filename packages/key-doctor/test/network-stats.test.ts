import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { KdReport } from "../src/index.ts";
import { aggregate, median, quantile, toMarkdown } from "../scripts/network-stats-lib.ts";

const load = (rel: string): KdReport => JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", rel), "utf8")) as KdReport;
const meta = { network: "testnet", block_height: 182340111, block_timestamp: "2026-11-03T02:00:10Z", ruleset_version: "2026-11-01", active_days: 365, daos_listed: 10, daos_active: 3, daos_failed: 1 };

describe("GĐ10 network stats aggregation", () => {
  it("median and quantiles", () => {
    assert.equal(median([1, 1, 3]), 1);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), 0);
    assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  });

  it("counts each council member once, keys by kind and use, and DAOs by council size", () => {
    const dao = load("reports/dao-kd-demo.report.json");
    const second: KdReport = structuredClone(dao);
    second.target.id = "other.sputnik-dao.testnet";
    second.summary.council_size = 1;
    second.members = [structuredClone(dao.members[0]!)];
    second.dao!.transfer_vote_policy[0]!.approvals_needed = 1;
    const s = aggregate([dao, second], meta);
    assert.equal(s.daos_scanned, 2);
    assert.deepEqual(s.council_size, { median: 2, p90: 3, one_member: 1 });
    assert.equal(s.daos_single_vote_transfer, 1);
    assert.equal(s.council_members, 3);
    assert.equal(s.members_with_ml_dsa, 1);
    assert.equal(s.members_with_ml_dsa_and_ed25519_full_access, 0);
    assert.equal(s.members_pq_ready, 1);
    assert.equal(s.members_high, 1);
    assert.equal(s.function_call_keys, 2);
    assert.equal(s.full_access_keys, 7);
    assert.equal(s.full_access_keys_never_used, 2);
  });

  it("skips unreadable members and never prints a name", () => {
    const dao = load("reports/dao-kd-demo.report.json");
    dao.members[1]!.error = "RPC_ERROR";
    const s = aggregate([dao], meta);
    assert.equal(s.members_unreadable, 1);
    const md = toMarkdown(s);
    assert.match(md, /\| Median council size \| 3 \(p90: 3\) \|/);
    assert.match(md, /1 DAO scans failed and 1 council members could not be read/);
    assert.doesNotMatch(JSON.stringify(s) + md, /kd-demo/);
  });
});
