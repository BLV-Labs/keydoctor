import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardDaoIds, paymentRows, readAgentBudgets, yieldRow, type AgentRow, type BudgetCard, type MyAgents } from "../src/agents-read.ts";
import type { BudgetLive, BudgetProposal, BudgetRequest } from "../src/budget-read.ts";
import { NEEDS_SHOWN, renderMyAgents, renderMyAgentsError, renderMyAgentsSignedOut, waitingItems } from "../src/agents-view.ts";
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

// Your agents (K2): the inbox merges the waiting requests of every budget.
const NOW = Date.UTC(2026, 10, 9, 12);
const HOUR = 3_600_000;
const NEAR = (n: number) => `${n}${"0".repeat(24)}`;
const nanos = (ms: number) => `${ms}000000`;
const PERIOD = nanos(24 * HOUR);

function proposal(id: number, ageHours: number): BudgetProposal {
  return { id, proposer: "g.guards.testnet", description: "pay", kind: { Transfer: { receiver_id: "v.testnet", amount: NEAR(2), token_id: "" } }, status: "InProgress", submission_time: nanos(NOW - ageHours * HOUR) };
}
function request(id: number, agent: string, receiver: string, reasons: string[], proposalId: number | null, ageHours: number): BudgetRequest {
  return { request_id: String(id), agent, receiver_id: receiver, amount: NEAR(2), memo: "", decision: "Pending", reasons, proposal_id: proposalId, status: "Pending", created_at: nanos(NOW - ageHours * HOUR) };
}
function budget(dao: string, proposals: BudgetProposal[] | null, requests: BudgetRequest[] = []): BudgetLive {
  return {
    dao: { dao, factory: "guards.testnet", code_storage: "0", policy: { roles: [], proposal_bond: "0", proposal_period: PERIOD } as unknown as GuardDao["policy"], guards: [] },
    guard: {
      guard_id: `g.${dao}`, name: "g", ready: true, in_role: true,
      config: { paused: false, proposal_bond: "0", agents: 1, whitelist: 1, guardians: [] },
      policy: { max_per_tx: NEAR(1), max_per_day: NEAR(4), max_pending_per_agent: 3, min_reserve: NEAR(1) },
      window: { spent_in_window: NEAR(1), remaining: NEAR(3), resets_at: "2026-11-10T00:00:00.000Z" },
      agents: [{ account_id: "bot.testnet", label: "Ops bot", enabled: true, pending: 0 }],
      whitelist: [{ account_id: "v.testnet", label: "", max_per_tx: null }],
    },
    balance: NEAR(12), withdrawable: NEAR(11), proposals, requests, plans: [],
  };
}
const card = (dao: string, live: BudgetLive | null): BudgetCard => ({ dao, live });
const data = (daos: string[], unread = 0): MyAgents => ({ network: "testnet", daos: daos.map((d) => ({ dao: d, members: ["alice.testnet"], error: null })), rows: [], budgetDaos: daos, unread });
const page = (cards: BudgetCard[], d: MyAgents = data(cards.map((c) => c.dao))) => renderMyAgents(d, ["alice.testnet"], cards, NOW).value;

describe("Your agents inbox", () => {
  const a = budget("a.sputnik-v2.testnet", [proposal(1, 5)], [request(10, "bot.testnet", "v.testnet", ["NOT_WHITELISTED"], 1, 5)]);
  const b = budget("b.sputnik-v2.testnet", [proposal(2, 2)], [request(20, "bot.testnet", "x.testnet", ["OVER_PER_TX"], 2, 2)]);

  it("merges every budget, newest first, with Reject and Review on each row", () => {
    const items = waitingItems([card("a.sputnik-v2.testnet", a), card("b.sputnik-v2.testnet", b)], NOW);
    assert.deepEqual(items.map((i) => [i.dao, i.proposal.id]), [["b.sputnik-v2.testnet", 2], ["a.sputnik-v2.testnet", 1]]);
    const html = page([card("a.sputnik-v2.testnet", a), card("b.sputnik-v2.testnet", b)]);
    assert.match(html, />2 waiting</);
    for (const dao of ["a.sputnik-v2.testnet", "b.sputnik-v2.testnet"]) {
      assert.match(html, new RegExp(`data-action="budget-act" data-dao="${dao}" data-id="\\d+" data-vote="VoteReject"`));
      assert.match(html, new RegExp(`data-action="budget-approve" data-dao="${dao}" data-id="\\d+"`));
    }
    assert.ok(html.indexOf("Needs you") < html.indexOf("Budgets and yield agents"));
    assert.match(html, /Approve and Reject each take 1 signature/);
  });

  it("drops an expired request", () => {
    const old = budget("c.sputnik-v2.testnet", [proposal(3, 30), proposal(4, 1)]);
    assert.deepEqual(waitingItems([card("c.sputnik-v2.testnet", old)], NOW).map((i) => i.proposal.id), [4]);
  });

  it("shows five rows, hides the rest behind Show all N", () => {
    const many = budget("d.sputnik-v2.testnet", Array.from({ length: 7 }, (_, i) => proposal(i + 1, i + 1)));
    const html = page([card("d.sputnik-v2.testnet", many)]);
    assert.equal(html.match(/class="inbox-row"(?! hidden)/g)?.length, NEEDS_SHOWN);
    assert.equal(html.match(/data-inbox-extra/g)?.length, 2);
    assert.match(html, /data-action="agents-show-all">Show all 7</);
    assert.doesNotMatch(page([card("a.sputnik-v2.testnet", a)]), /agents-show-all/);
  });

  it("a failed budget gets its own retry card and the others stay", () => {
    const html = page([card("a.sputnik-v2.testnet", a), card("bad.sputnik-v2.testnet", null)]);
    assert.match(html, /Could not read this budget/);
    assert.match(html, /data-action="agents-retry" data-dao="bad\.sputnik-v2\.testnet">Try again</);
    assert.match(html, /bot\.testnet wants to pay|Ops bot wants to pay/);
    assert.match(html, />1 waiting</);
  });

  it("a budget whose waiting list could not be read is called unknown, not empty", () => {
    const html = page([card("e.sputnik-v2.testnet", budget("e.sputnik-v2.testnet", null))]);
    assert.match(html, /Nothing needs you right now/);
    assert.match(html, /unknown, not none/);
  });

  it("the sub line counts budgets and agents", () => {
    const d = { ...data(["a.sputnik-v2.testnet", "b.sputnik-v2.testnet"]), rows: [{ kind: "payment", dao: "a", account: "x", label: "x", status: "on", pending: 0, spent_24h: null, supplied: null }, { kind: "payment", dao: "b", account: "y", label: "y", status: "on", pending: 0, spent_24h: null, supplied: null }, { kind: "yield", dao: "b", account: null, label: "Yield agent", status: "idle", pending: 0, spent_24h: null, supplied: "0" }] as AgentRow[] };
    assert.match(page([card("a.sputnik-v2.testnet", a), card("b.sputnik-v2.testnet", b)], d), /2 budgets · 3 agents · everything they did in the last 24 hours/);
  });

  it("says why a request waits in plain words", () => {
    const html = page([card("a.sputnik-v2.testnet", a), card("b.sputnik-v2.testnet", b)]);
    assert.match(html, /Not on your recipient list/);
    assert.match(html, /More than the 1 NEAR limit per payment/);
  });

  it("recent activity shows at most five events across budgets", () => {
    const reqs = Array.from({ length: 4 }, (_, i) => request(100 + i, "bot.testnet", "v.testnet", [], null, 10 + i));
    const html = page([card("a.sputnik-v2.testnet", budget("a.sputnik-v2.testnet", [], reqs)), card("b.sputnik-v2.testnet", budget("b.sputnik-v2.testnet", [], reqs))]);
    const activity = html.slice(html.indexOf("Recent activity"), html.indexOf('id="alerts"'));
    assert.equal(activity.match(/class="activity-row/g)?.length, 5);
  });

  it("keeps the machinery out of sight outside Technical details", () => {
    const jargon = /\bDAO\b|\b[Pp]roposals?\b|\bGuard\b|Sputnik|yocto|whitelist|policy/;
    const shown = (out: string) => out.replace(/<details class="card tech">[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");
    const many = budget("d.sputnik-v2.testnet", Array.from({ length: 6 }, (_, i) => proposal(i + 1, i + 1)), [request(1, "bot.testnet", "v.testnet", ["OVER_DAILY_LIMIT"], 1, 1)]);
    for (const out of [
      page([card("a.sputnik-v2.testnet", a), card("bad.sputnik-v2.testnet", null), card("d.sputnik-v2.testnet", many)]),
      page([]),
      renderMyAgentsSignedOut().value,
      renderMyAgentsError("We could not read your budgets right now. Nothing was changed.", ["alice.testnet"]).value,
    ]) {
      assert.doesNotMatch(shown(out), jargon);
    }
    assert.match(page([]), /No agents yet/);
  });
});

describe("readAgentBudgets", () => {
  it("one failed read gives that card no data and leaves the others", async () => {
    const ok = budget("a.sputnik-v2.testnet", []);
    const read = (async (dao: string) => {
      if (dao === "bad.sputnik-v2.testnet") throw new Error("rpc down");
      return ok;
    }) as unknown as Parameters<typeof readAgentBudgets>[3];
    const cards = await readAgentBudgets(["a.sputnik-v2.testnet", "bad.sputnik-v2.testnet"], "f.testnet", "testnet", read);
    assert.deepEqual(cards.map((c) => [c.dao, c.live === null]), [["a.sputnik-v2.testnet", false], ["bad.sputnik-v2.testnet", true]]);
  });
});
