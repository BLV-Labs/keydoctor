import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardDaoIds, paymentRows, yieldRow, type AgentRow } from "../src/agents-read.ts";
import { agentMatches, renderMyAgents } from "../src/agents-view.ts";
import type { GuardDao, GuardLive } from "../src/guard-read.ts";
import { parseRoute, yieldHref } from "../src/route.ts";

const DAO = "demo.sputnikv2.testnet";

function guard(paused: boolean, agents: NonNullable<GuardLive["agents"]>): GuardLive {
  return {
    guard_id: "ops.guards.kd-demo.testnet", name: "ops", ready: true, in_role: true,
    config: { paused, proposal_bond: "0", agents: agents.length, whitelist: 0, guardians: [] },
    policy: null, window: null, agents, whitelist: null,
  };
}
const dao = (guards: GuardLive[]): GuardDao => ({ dao: DAO, factory: "guards.kd-demo.testnet", code_storage: "0", policy: { roles: [], proposal_bond: "0" } as unknown as GuardDao["policy"], guards });

describe("My Agents rows", () => {
  it("lists each DAO once from list_guards", () => {
    assert.deepEqual(guardDaoIds([{ dao_id: "a.testnet" }, { dao_id: "b.testnet" }, { dao_id: "a.testnet" }, null, { x: 1 }]), ["a.testnet", "b.testnet"]);
  });

  // A paused Guard rejects every request, so a waiting count on it must not read as "act now".
  it("shows off before waiting", () => {
    const rows = paymentRows(dao([guard(true, [{ account_id: "bot.testnet", label: "Bot", enabled: true, pending: 2 }])]));
    assert.equal(rows[0]!.status, "off");
    const live = paymentRows(dao([guard(false, [
      { account_id: "a.testnet", label: "A", enabled: true, pending: 1, spent_24h: "5" },
      { account_id: "b.testnet", label: "B", enabled: true, pending: 0 },
      { account_id: "c.testnet", label: "C", enabled: false, pending: 3 },
    ])]));
    assert.deepEqual(live.map((r) => r.status), ["waiting", "on", "off"]);
    assert.equal(live[0]!.spent_24h, "5");
    assert.equal(live[1]!.spent_24h, null);
  });

  it("sums supplied yield and keeps unread as unknown", () => {
    assert.deepEqual([yieldRow(DAO, [{ token_id: "t", supplied: "2" }, { token_id: "u", supplied: "3" }]).status, yieldRow(DAO, [{ token_id: "t", supplied: "2" }, { token_id: "u", supplied: "3" }]).supplied], ["farming", "5"]);
    assert.equal(yieldRow(DAO, []).status, "idle");
    assert.equal(yieldRow(DAO, null).supplied, null);
    assert.equal(yieldRow(DAO, null).status, "unknown");
  });

  it("filters by what needs the council, kind and off", () => {
    const waiting = { kind: "payment", status: "waiting" } as AgentRow;
    const farming = { kind: "yield", status: "farming" } as AgentRow;
    assert.equal(agentMatches(waiting, "needs"), true);
    assert.equal(agentMatches(farming, "needs"), false);
    assert.equal(agentMatches(farming, "yield"), true);
    assert.equal(agentMatches(waiting, "yield"), false);
    assert.equal(agentMatches({ kind: "payment", status: "off" } as AgentRow, "off"), true);
  });

  it("puts waiting agents first", () => {
    const rows: AgentRow[] = [
      { kind: "yield", dao: DAO, account: null, label: "Yield agent", status: "idle", pending: 0, spent_24h: null, supplied: "0" },
      { kind: "payment", dao: DAO, account: "late.testnet", label: "Late", status: "waiting", pending: 1, spent_24h: "0", supplied: null },
    ];
    const page = renderMyAgents({ network: "testnet", daos: [{ dao: DAO, members: ["alice.testnet"], error: null }], rows, unread: 0 }, ["alice.testnet"]).value;
    assert.ok(page.indexOf(`data-agent-kind="payment"`) < page.indexOf(`data-agent-kind="yield"`));
    assert.ok(page.indexOf(`data-agent-kind="payment"`) > 0);
  });
});

describe("routes", () => {
  it("parses the yield page DAO and My Agents", () => {
    const r = parseRoute(yieldHref(DAO));
    assert.equal(r.page, "yield");
    assert.equal(r.dao, DAO);
    assert.equal(parseRoute("?page=yield").dao, null);
    assert.equal(parseRoute("?page=my-agents").page, "my-agents");
    assert.equal(parseRoute("?page=yield&dao=%20bad%20name").dao, null);
  });
});
