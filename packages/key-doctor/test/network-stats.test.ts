import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { KdReport } from "../src/index.ts";
import { aggregate, isSettled, median, quantile, toMarkdown } from "../scripts/network-stats-lib.ts";

const load = (rel: string): KdReport => JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", rel), "utf8")) as KdReport;
const meta = { network: "testnet", scope: "active" as const, block_height: 182340111, block_timestamp: "2026-11-03T02:00:10Z", ruleset_version: "2026-11-01", active_days: 365, daos_listed: 10, daos_active: 3, daos_failed: 1, daos_failed_by_code: { NOT_A_DAO: 1 } };

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
    assert.match(md, /1 DAO scans failed \(NOT_A_DAO 1\) and 1 council members could not be read \(RPC_ERROR 1\)/);
    assert.doesNotMatch(JSON.stringify(s) + md, /kd-demo/);
  });

  it("says whether the numbers cover active DAOs only or every listed DAO, so a reader cannot mix the two", () => {
    const dao = load("reports/dao-kd-demo.report.json");
    assert.match(toMarkdown(aggregate([dao], meta)), /^Measured on 1 active Sputnik DAOs on testnet \(a proposal in the last 365 days\)/);
    const all = aggregate([dao], { ...meta, scope: "all" });
    assert.equal(all.scope, "all");
    assert.match(toMarkdown(all), /^Measured on 1 of the 10 Sputnik DAOs on testnet listed by the factory \(3 of them had a proposal in the last 365 days\)/);
  });

  it("failure breakdowns come out in one key order whatever order the scans finished in, so two runs give the same file", () => {
    const dao = load("reports/dao-kd-demo.report.json");
    dao.members[0]!.error = "RPC_ERROR";
    dao.members[1]!.error = "LIMIT_EXCEEDED";
    const a = aggregate([dao], { ...meta, daos_failed: 3, daos_failed_by_code: { NOT_A_DAO: 2, LIMIT_EXCEEDED: 1 } });
    const b = aggregate([dao], { ...meta, daos_failed: 3, daos_failed_by_code: { LIMIT_EXCEEDED: 1, NOT_A_DAO: 2 } });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.deepEqual(Object.keys(a.daos_failed_by_code), ["LIMIT_EXCEEDED", "NOT_A_DAO"]);
    assert.deepEqual(Object.keys(a.members_unreadable_by_code), ["LIMIT_EXCEEDED", "RPC_ERROR"]);
    assert.match(toMarkdown(a), /3 DAO scans failed \(NOT_A_DAO 2, LIMIT_EXCEEDED 1\)/);
  });

  it("only the chain's own answers count as settled; node trouble is asked again elsewhere and never cached", () => {
    const err = (name: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name } } });
    // Same on every node at a pinned block: cache it.
    assert.equal(isSettled(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { keys: [] } })), true);
    assert.equal(isSettled(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { error: "wasm execution failed", logs: [] } })), true);
    for (const name of ["UNKNOWN_ACCOUNT", "NO_CONTRACT_CODE", "TOO_MANY_ACCESS_KEYS"]) assert.equal(isSettled(err(name)), true, name);
    // About the node, not the chain: a pruned node, a timeout, a busy node, a cut body. Caching these made counts drift.
    for (const name of ["UNKNOWN_BLOCK", "TIMEOUT_ERROR", "INTERNAL_ERROR", "NO_SYNCED_BLOCKS"]) assert.equal(isSettled(err(name)), false, name);
    assert.equal(isSettled('{"jsonrpc":"2.0","id":1,"res'), false);
    assert.equal(isSettled(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server error" } })), false);
  });
});
