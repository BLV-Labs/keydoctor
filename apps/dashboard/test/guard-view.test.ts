import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addGuardRoleProposal, createGuardProposal, guardChangeProposal, type RawPolicy } from "../src/guard-proposals.ts";
import type { GuardDao, GuardLive } from "../src/guard-read.ts";
import { renderGuardCard, renderGuardCreate, renderGuardDao, renderGuardPreview, renderGuardStart } from "../src/guard-view.ts";
import { guardHref, parseRoute } from "../src/route.ts";

const FACTORY = "guards.kdfactory.testnet";
const DAO = "kdoncall.sputnik-v2.testnet";
const NEAR = 10n ** 24n;
const policy: RawPolicy = {
  roles: [{ name: "council", kind: { Group: ["alice.testnet"] }, permissions: ["*:*"], vote_policy: {} }],
  proposal_bond: (NEAR / 10n).toString(),
};

const guard = (over: Partial<GuardLive> = {}): GuardLive => ({
  guard_id: `payroll.${FACTORY}`,
  name: "payroll",
  ready: true,
  in_role: true,
  config: { paused: false, proposal_bond: policy.proposal_bond, agents: 1, whitelist: 2, guardians: [] },
  policy: { max_per_tx: (5n * NEAR).toString(), max_per_day: (10n * NEAR).toString(), max_pending_per_agent: 3, min_reserve: NEAR.toString() },
  window: { spent_in_window: "0", remaining: (10n * NEAR).toString(), resets_at: "2026-11-03T00:00:00Z" },
  agents: [{ account_id: "bot.kdoncall.testnet", label: "payroll bot", enabled: true, pending: 0 }],
  ...over,
});

describe("Agent Guard route", () => {
  it("keeps the DAO in the URL so a council member can share the page", () => {
    const route = parseRoute(new URL(`https://kd.test/${guardHref(DAO)}`).search);
    assert.equal(route.page, "guard");
    assert.equal(route.dao, DAO);
  });
});

describe("renderGuardStart", () => {
  it("explains how to configure a build with no factory instead of offering a form that cannot work", () => {
    const out = renderGuardStart("", null, "").value;
    assert.match(out, /No Guard factory in this build/);
    assert.doesNotMatch(out, /guard-dao-form/);
  });

  it("shows the error next to the DAO field and escapes the typed DAO", () => {
    const out = renderGuardStart('<b>"x"</b>', "not a DAO", FACTORY).value;
    assert.match(out, /aria-invalid="true"/);
    assert.match(out, /not a DAO/);
    assert.doesNotMatch(out, /<b>"x"<\/b>/);
  });
});

describe("renderGuardCard", () => {
  it("gives the agent owner a key limited to this Guard's two methods and the MCP line", () => {
    const out = renderGuardCard(guard(), "testnet").value;
    assert.match(out, /Active/);
    assert.match(out, /--contract-account-id payroll\.guards\.kdfactory\.testnet/);
    assert.match(out, /request_transfer, sync_request/);
    assert.match(out, /claude mcp add guard/);
    assert.match(out, /AGENT_ACCOUNT_ID=bot\.kdoncall\.testnet/);
  });

  it("warns when the role proposal has not passed: the Guard cannot propose transfers yet", () => {
    const out = renderGuardCard(guard({ in_role: false }), "testnet").value;
    assert.match(out, /Not in role agent-guard/);
    assert.match(out, /cannot propose transfers/);
  });

  it("says limits are unknown, not absent, when the views fail", () => {
    const out = renderGuardCard(guard({ config: null, policy: null, window: null }), "testnet").value;
    assert.match(out, /unknown, not absent/);
    assert.doesNotMatch(out, /Per transfer/);
  });

  it("offers no change form while the Guard is still being created", () => {
    const out = renderGuardCard(guard({ ready: false, config: null, policy: null, window: null, agents: null }), "testnet").value;
    assert.match(out, /Creating/);
    assert.doesNotMatch(out, /guard-change-form/);
  });
});

describe("renderGuardDao and renderGuardCreate", () => {
  it("shows the empty state and the create form for a DAO with no Guard", () => {
    const state: GuardDao = { dao: DAO, factory: FACTORY, code_storage: "2483120000000000000000000", policy, guards: [] };
    const out = renderGuardDao(state, "testnet").value;
    assert.match(out, /has no Guard from/);
    assert.match(out, /id="guard-create-form"/);
    assert.match(out, /id="guard-preview"/);
  });

  it("keeps typed values and puts line numbers on list errors", () => {
    const out = renderGuardCreate(FACTORY, { name: "pay<roll>", agents: "bad" }, [{ field: "agents.0.account_id", code: "INVALID_ACCOUNT" }]).value;
    assert.match(out, /value="pay&lt;roll&gt;"/);
    assert.match(out, /Line 1: /);
    assert.match(out, /id="gf-agents"[^>]*aria-invalid="true"/);
  });
});

describe("renderGuardPreview", () => {
  it("attaches one bond per proposal and decodes the create args the council will vote on", () => {
    const args = {
      name: "payroll",
      dao_id: DAO,
      policy: { max_per_tx: "1", max_per_day: "2", max_pending_per_agent: 3, min_reserve: "0" },
      agents: [],
      whitelist: [],
      guardians: [],
    };
    const p1 = createGuardProposal(FACTORY, args as never, (5n * NEAR).toString());
    const p2 = addGuardRoleProposal(policy, `payroll.${FACTORY}`);
    assert.ok(p2);
    const out = renderGuardPreview({ dao: DAO, bond: policy.proposal_bond, proposals: [p1, p2], notes: ["Vote both."] }).value;
    assert.match(out, /× 2 = <strong>0\.2 NEAR<\/strong>/);
    assert.match(out, /&quot;dao_id&quot;: &quot;kdoncall\.sputnik-v2\.testnet&quot;|"dao_id": "kdoncall\.sputnik-v2\.testnet"/);
    assert.match(out, /transfer:AddProposal/);
    assert.match(out, /data-action="guard-sign"/);
  });

  it("shows the storage deposit a change that adds an entry takes from the DAO", () => {
    const out = renderGuardPreview({
      dao: DAO,
      bond: policy.proposal_bond,
      proposals: [guardChangeProposal(`payroll.${FACTORY}`, "add_guardian", { account_id: "alice.testnet" })],
      notes: [],
    }).value;
    assert.match(out, /add_guardian<\/code> with 0\.01 NEAR/);
    assert.match(out, /= <strong>0\.1 NEAR<\/strong>/);
  });
});
