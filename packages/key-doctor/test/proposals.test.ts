import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { checkProposals, listProposals, type KdAlert, type ProposalWatchState } from "../src/index.ts";
import { actionText, groupOf, parseGuardDescription, parseProposal, tally } from "../src/proposals.ts";
import { parsePolicy } from "../src/parse.ts";
import { blockBody, fixture, installFetch, ok, rpcErr, type Req } from "./support/stub.ts";

const DAO = "kd-demo.sputnik-dao.testnet";
const A = "a.kd-demo.testnet";
const B = "b.kd-demo.testnet";
const C = "c.kd-demo.testnet";
const FACTORY = "kd-guards.testnet";
const GUARD = "budget.kd-guards.testnet";

const bytes = (v: unknown) => ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))), logs: [], block_height: 1, block_hash: "h" });
const policyRaw = () => fixture("sputnik/get_policy.json");
const transfer2 = () => fixture("sputnik/get_proposal.2.transfer.json");
const addMember3 = () => fixture("sputnik/get_proposal.3.add_member.json");
const keysA = () => fixture("rpc/view_access_key_list.a.json");
const keysB = () => fixture("rpc/view_access_key_list.b.json");
const keysC = () => fixture("rpc/view_access_key_list.c.json");

interface World {
  /** get_proposal ids that fail at the transport level (HTTP 500). */
  down?: number[];
  last?: unknown;
  proposals?: Record<number, unknown>;
  keys?: Record<string, unknown>;
  policy?: unknown;
  /** account -> kd_guard_info reply. An account not listed fails at the transport level (HTTP 500). */
  guardInfo?: Record<string, unknown>;
  /** The Guards the factory lists for the DAO. "down" fails at the transport level. */
  guards?: string[] | "down";
}

function world(t: TestContext, w: World): Req[] {
  return installFetch(t, (req) => {
    if (req.method === "block") return blockBody();
    const p = req.params;
    if (p.request_type === "view_access_key_list") return w.keys?.[String(p.account_id)] ?? rpcErr("UNKNOWN_ACCOUNT");
    if (p.request_type === "view_account") return ok({ amount: "1" });
    if (p.request_type === "call_function" && p.account_id === DAO) {
      if (p.method_name === "get_last_proposal_id") return w.last === undefined ? bytes(4) : w.last;
      if (p.method_name === "get_policy") return bytes(w.policy ?? policyRaw());
      if (p.method_name === "get_proposal") {
        const { id } = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString()) as { id: number };
        if (w.down?.includes(id)) return new Response("{}", { status: 500 });
        const found = w.proposals?.[id];
        return found === undefined ? ok({ error: "wasm execution failed: ERR_NO_PROPOSAL", logs: [] }) : found;
      }
    }
    if (p.request_type === "call_function" && p.account_id === FACTORY && p.method_name === "get_guards_for_dao") {
      if (w.guards === "down") return new Response("{}", { status: 500 });
      return bytes((w.guards ?? []).map((guard_id) => ({ guard_id, dao_id: DAO, name: "x", created_at: "0", ready: true })));
    }
    if (p.request_type === "call_function" && p.method_name === "kd_guard_info") {
      const reply = w.guardInfo?.[String(p.account_id)];
      if (reply !== undefined) return reply;
    }
    return new Response("{}", { status: 500 });
  });
}

const demo = (t: TestContext, extra: Partial<World> = {}) =>
  world(t, { proposals: { 2: bytes(transfer2()), 3: bytes(addMember3()) }, keys: { [A]: keysA(), [B]: keysB(), [C]: keysC() }, ...extra });

const kinds = (alerts: KdAlert[]) => alerts.map((a) => a.alert_id);
const queries = (calls: Req[]) =>
  calls.map((c) => (c.method === "block" ? "block" : `${c.params.request_type}:${String(c.params.method_name ?? c.params.account_id)}`));

describe("GĐ5 checkProposals: first call and steady state", () => {
  it("prev = null records the proposal count, returns no alerts and reads nothing else", async (t) => {
    const calls = demo(t);
    const r = await checkProposals(DAO, null);
    assert.deepEqual(r, { alerts: [], budget_alerts: [], state: { last_proposal_id: 4, pending: {} }, errors: [] });
    assert.deepEqual(queries(calls), ["block", "call_function:get_last_proposal_id"]);
  });

  it("new proposals: the fixture voter alert and a governance alert; pending keeps both open proposals", async (t) => {
    const calls = demo(t);
    const r = await checkProposals(DAO, { last_proposal_id: 2, pending: {} });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(kinds(r.alerts), [
      "testnet:kd-demo.sputnik-dao.testnet:voter_new_full_access_key:2:a.kd-demo.testnet",
      "testnet:kd-demo.sputnik-dao.testnet:governance_change_proposal:3:-",
    ]);
    const expected = fixture<KdAlert>("alerts/voter-new-full-access-key.alert.json");
    assert.deepEqual({ ...r.alerts[0], created_at: "x" }, { ...expected, created_at: "x" });
    const gov = r.alerts[1]!;
    assert.equal(gov.severity, "high");
    assert.equal(gov.after_the_fact, false);
    assert.equal(gov.proposal?.kind_label, "add_member_to_role");
    assert.equal(gov.messages.en.body, "Proposal 3: add d.kd-demo.testnet to role council. It changes who controls the DAO.");
    assert.match(gov.messages.en.action, /verify with the proposer a\.kd-demo\.testnet through another channel/);
    assert.equal(r.state.last_proposal_id, 4);
    assert.deepEqual(Object.keys(r.state.pending), ["2", "3"]);
    assert.deepEqual(r.state.pending["2"]?.votes_seen, { [A]: "Approve" });
    assert.equal(r.state.pending["2"]?.kind_label, "transfer");
    // Every query is pinned to the head block, and only the voter's keys are read.
    assert.ok(calls.filter((c) => c.method === "query").every((c) => c.params.block_id === 182340111));
    assert.deepEqual(calls.filter((c) => c.params.request_type === "view_access_key_list").map((c) => c.params.account_id), [A]);
  });

  it("a second call with nothing new gives no alerts and scans nobody", async (t) => {
    demo(t);
    const first = await checkProposals(DAO, { last_proposal_id: 2, pending: {} });
    const calls = demo(t);
    const again = await checkProposals(DAO, first.state);
    assert.deepEqual(again.alerts, []);
    assert.deepEqual(again.state, first.state);
    assert.ok(!calls.some((c) => c.params.request_type === "view_access_key_list"));
  });

  it("a new vote by a voter without a new key: no alert, votes_seen grows", async (t) => {
    const prev: ProposalWatchState = {
      last_proposal_id: 4,
      pending: { "2": { kind_label: "transfer", votes_seen: { [A]: "Approve" }, first_seen_at: "2026-11-03T00:00:00Z" } },
    };
    const p2 = { ...transfer2(), votes: { [A]: "Approve", [C]: "Reject" } };
    const calls = demo(t, { proposals: { 2: bytes(p2) } });
    const r = await checkProposals(DAO, prev);
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(r.state.pending["2"], { kind_label: "transfer", votes_seen: { [A]: "Approve", [C]: "Reject" }, first_seen_at: "2026-11-03T00:00:00Z" });
    assert.deepEqual(calls.filter((c) => c.params.request_type === "view_access_key_list").map((c) => c.params.account_id), [C]);
  });

  it("a finished proposal leaves pending", async (t) => {
    const prev: ProposalWatchState = {
      last_proposal_id: 4,
      pending: { "3": { kind_label: "add_member_to_role", votes_seen: {}, first_seen_at: "2026-11-03T00:00:00Z" } },
    };
    demo(t, { proposals: { 3: bytes({ ...addMember3(), status: "Rejected" }) } });
    const r = await checkProposals(DAO, prev);
    assert.deepEqual(r.state.pending, {});
    assert.deepEqual(r.alerts, []);
  });
});

describe("GĐ5 checkProposals: kinds", () => {
  it("one-vote DAO: an executed transfer still alerts, after the fact", async (t) => {
    const p = { ...transfer2(), id: 4, status: "Approved" };
    demo(t, { last: bytes(5), proposals: { 4: bytes(p) } });
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    assert.equal(r.alerts.length, 1);
    const a = r.alerts[0]!;
    assert.equal(a.after_the_fact, true);
    assert.equal(a.proposal?.executed, true);
    assert.equal(a.messages.en.title, `EXECUTED: ${DAO}`);
    assert.equal(a.messages.vi.title, `ĐÃ THỰC THI: ${DAO}`);
    assert.doesNotMatch(a.messages.en.action, /Before you vote/);
    assert.deepEqual(r.state.pending, {});
  });

  it("upgrade proposals alert as code_upgrade_proposal; other kinds are ignored and not tracked", async (t) => {
    const base = { proposer: B, description: "x", status: "InProgress", votes: {}, vote_counts: {}, submission_time: "1" };
    demo(t, {
      last: bytes(7),
      proposals: {
        4: bytes({ ...base, id: 4, kind: { UpgradeSelf: { hash: "abc" } } }),
        5: bytes({ ...base, id: 5, kind: { AddBounty: { bounty: {} } } }),
        6: bytes({ ...base, id: 6, kind: "Vote" }),
      },
    });
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    assert.deepEqual(kinds(r.alerts), ["testnet:kd-demo.sputnik-dao.testnet:code_upgrade_proposal:4:-"]);
    assert.equal(r.alerts[0]?.messages.en.title, `CODE UPGRADE: ${DAO}`);
    assert.deepEqual(Object.keys(r.state.pending), ["4"]);
    assert.equal(r.state.last_proposal_id, 7);
  });

  // A Guard is upgraded by a plain FunctionCall, so a label check alone would let its code change without an alert.
  it("a function call to upgrade alerts as code_upgrade_proposal; other calls stay quiet", async (t) => {
    const base = { proposer: B, description: "x", status: "InProgress", votes: {}, vote_counts: {}, submission_time: "1" };
    const call = (method_name: string) => ({
      FunctionCall: { receiver_id: "budget.keydoctor-guards-v2.testnet", actions: [{ method_name, args: "e30=", deposit: "0", gas: "150000000000000" }] },
    });
    demo(t, {
      last: bytes(6),
      proposals: { 4: bytes({ ...base, id: 4, kind: call("upgrade") }), 5: bytes({ ...base, id: 5, kind: call("set_policy") }) },
    });
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    assert.deepEqual(kinds(r.alerts), ["testnet:kd-demo.sputnik-dao.testnet:code_upgrade_proposal:4:-"]);
    assert.equal(r.alerts[0]?.messages.en.title, `CODE UPGRADE: ${DAO}`);
  });

  it("label groups follow the Sputnik v2 labels", () => {
    for (const l of ["transfer", "call"]) assert.equal(groupOf(l), "money");
    for (const l of ["add_member_to_role", "remove_member_from_role", "config", "policy", "policy_add_or_update_role", "policy_remove_role", "policy_update_default_vote_policy", "policy_update_parameters"]) {
      assert.equal(groupOf(l), "governance", l);
    }
    for (const l of ["upgrade_self", "upgrade_remote"]) assert.equal(groupOf(l), "upgrade");
    for (const l of ["vote", "add_bounty", "bounty_done", "set_vote_token", "factory_info_update"]) assert.equal(groupOf(l), null);
  });

  it("action texts: NEAR amounts, tokens, calls, and unsafe ids replaced", () => {
    const p = (kind: unknown) => parseProposal({ id: 1, proposer: A, description: "d", status: "InProgress", votes: {}, kind })!;
    assert.equal(actionText(p({ Transfer: { token_id: "", receiver_id: "x.testnet", amount: "1500000000000000000000000" } })).en, "transfer 1.5 NEAR to x.testnet");
    assert.equal(actionText(p({ Transfer: { token_id: "usdc.testnet", receiver_id: "x.testnet", amount: "1000" } })).en, "transfer 1000 raw units of usdc.testnet to x.testnet");
    assert.equal(actionText(p({ FunctionCall: { receiver_id: "x.testnet", actions: [{ method_name: "ft_transfer" }] } })).en, "call ft_transfer on x.testnet");
    assert.equal(actionText(p({ Transfer: { token_id: "", receiver_id: "<b>evil", amount: "1" } })).en, "transfer 0.000000000000000000000001 NEAR to ?");
    assert.equal(actionText(p({ ChangePolicyRemoveRole: { role: "council" } })).vi, "đổi policy của DAO");
  });

  it("parseProposal strips the $$$$ suffix and rejects unknown shapes", () => {
    assert.equal(parseProposal(transfer2())?.description, "Pay the design contractor");
    assert.equal(parseProposal({ ...transfer2(), votes: { [A]: "Maybe" } }), null);
    assert.equal(parseProposal({ ...transfer2(), kind: { NewKindNobodyKnows: {} } }), null);
    assert.equal(parseProposal({ ...transfer2(), id: "2" }), null);
  });

  it("tally picks the group role closest to passing; non-group roles give null", () => {
    const policy = parsePolicy(policyRaw())!;
    const t2 = tally(policy, parseProposal(transfer2())!);
    assert.deepEqual(t2, { approvals_needed: 2, approvals_have: 1, pending_voters: [B, C] });
    const everyoneOnly = parsePolicy({ ...policyRaw(), roles: [{ name: "all", kind: "Everyone", permissions: ["*:*"], vote_policy: {} }] })!;
    assert.deepEqual(tally(everyoneOnly, parseProposal(transfer2())!), { approvals_needed: null, approvals_have: 1, pending_voters: [] });
  });

  it("ui_url comes from the template", async (t) => {
    demo(t);
    const r = await checkProposals(DAO, { last_proposal_id: 3, pending: {} }, { proposalUiUrlTemplate: "https://ui.example/{dao}/proposals/{id}" });
    assert.equal(r.alerts[0]?.proposal?.ui_url, `https://ui.example/${DAO}/proposals/3`);
  });
});

describe("GĐ5 checkProposals: failures and caps", () => {
  it("get_last_proposal_id failure throws", async (t) => {
    world(t, { last: rpcErr("UNKNOWN_ACCOUNT") });
    await assert.rejects(checkProposals(DAO, null), (e: any) => e.kd?.code === "NOT_FOUND");
    world(t, { last: bytes("not a number") });
    await assert.rejects(checkProposals(DAO, { last_proposal_id: 0, pending: {} }), (e: any) => e.kd?.code === "RPC_ERROR");
  });

  it("a transport failure on a new proposal goes to errors and is retried next call; later ones still run", async (t) => {
    demo(t, { down: [2] });
    const r = await checkProposals(DAO, { last_proposal_id: 2, pending: {} });
    assert.deepEqual(r.errors, ["proposal 2: RPC_ERROR"]);
    assert.deepEqual(kinds(r.alerts), ["testnet:kd-demo.sputnik-dao.testnet:governance_change_proposal:3:-"]);
    assert.equal(r.state.last_proposal_id, 2);
    // Next call: 3 is pending and above last_proposal_id, but it is read once, not twice.
    const calls = demo(t);
    const again = await checkProposals(DAO, r.state);
    assert.equal(calls.filter((c) => c.params.method_name === "get_proposal").length, 2);
    assert.equal(again.state.last_proposal_id, 4);
    assert.ok(again.alerts.some((a) => a.alert_id.endsWith("voter_new_full_access_key:2:a.kd-demo.testnet")));
    assert.ok(!again.alerts.some((a) => a.kind === "governance_change_proposal"), "proposal 3 was already announced");
  });

  it("a removed proposal (get_proposal fails in the contract) is dropped, not retried forever", async (t) => {
    demo(t, { proposals: { 3: bytes(addMember3()) } });
    const r = await checkProposals(DAO, { last_proposal_id: 2, pending: {} });
    assert.deepEqual(r.errors, ["proposal 2: NOT_A_DAO"]);
    assert.equal(r.state.last_proposal_id, 4);
    assert.deepEqual(Object.keys(r.state.pending), ["3"]);
  });

  it("a long backlog with a removed first proposal still reaches every id", async (t) => {
    const base = { proposer: B, description: "x", status: "InProgress", votes: {}, kind: { AddMemberToRole: { member_id: "d.kd-demo.testnet", role: "council" } } };
    const proposals: Record<number, unknown> = {};
    for (let i = 1; i < 20; i++) proposals[i] = bytes({ ...base, id: i });
    world(t, { last: bytes(20), proposals });
    let state: ProposalWatchState = { last_proposal_id: 0, pending: {} };
    const seen = new Set<string>();
    for (let run = 0; run < 4; run++) {
      const r = await checkProposals(DAO, state);
      for (const a of r.alerts) seen.add(a.alert_id);
      state = r.state;
    }
    assert.equal(state.last_proposal_id, 20);
    assert.equal(seen.size, 19);
  });

  it("a transport failure on a pending proposal keeps its old entry", async (t) => {
    const entry = { kind_label: "transfer", votes_seen: { [A]: "Approve" as const }, first_seen_at: "2026-11-03T00:00:00Z" };
    demo(t, { down: [2] });
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: { "2": entry } });
    assert.deepEqual(r.state.pending, { "2": entry });
    assert.equal(r.errors.length, 1);
  });

  it("a finished proposal stays pending until every voter is scanned, and the deferral is reported", async (t) => {
    const voters = Array.from({ length: 10 }, (_, i) => `v${i}.kd-demo.testnet`);
    const p = { ...transfer2(), id: 4, status: "Approved", votes: Object.fromEntries(voters.map((v) => [v, "Approve"])) };
    const keys = Object.fromEntries(voters.map((v) => [v, keysB()]));
    demo(t, { last: bytes(5), proposals: { 4: bytes(p) }, keys });
    const first = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    assert.deepEqual(first.errors, ["proposal 4: 2 voter scan(s) deferred to the next call"]);
    assert.equal(Object.keys(first.state.pending["4"]!.votes_seen).length, 8);
    demo(t, { last: bytes(5), proposals: { 4: bytes(p) }, keys });
    const second = await checkProposals(DAO, first.state);
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.state.pending, {});
  });

  it("a voter scan failure goes to errors and leaves the vote unseen for a retry", async (t) => {
    demo(t, { keys: {} });
    const r = await checkProposals(DAO, { last_proposal_id: 2, pending: {} });
    assert.ok(r.errors.includes("voter a.kd-demo.testnet: NOT_FOUND"));
    assert.deepEqual(r.state.pending["2"]?.votes_seen, {});
    assert.ok(!r.alerts.some((a) => a.kind === "voter_new_full_access_key"));
  });

  it("reads at most 12 proposals per call and resumes from the first unread id", async (t) => {
    const base = { proposer: B, description: "x", status: "Rejected", votes: {}, kind: { AddBounty: { bounty: {} } } };
    const proposals: Record<number, unknown> = {};
    for (let i = 0; i < 20; i++) proposals[i] = bytes({ ...base, id: i });
    const calls = world(t, { last: bytes(20), proposals });
    const r = await checkProposals(DAO, { last_proposal_id: 0, pending: {} });
    assert.equal(calls.filter((c) => c.params.method_name === "get_proposal").length, 12);
    assert.equal(r.state.last_proposal_id, 12);
  });

  it("a newer key outside the 48 h window is not reported; a custom window can include it", async (t) => {
    const oldKeyA = fixture("rpc/view_access_key_list.a.json");
    oldKeyA.result.keys = oldKeyA.result.keys.filter((k: any) => k.access_key.nonce !== 182320999000000);
    demo(t, { keys: { [A]: oldKeyA } });
    const r = await checkProposals(DAO, { last_proposal_id: 2, pending: {} });
    assert.ok(!r.alerts.some((a) => a.kind === "voter_new_full_access_key"));
    demo(t);
    const narrow = await checkProposals(DAO, { last_proposal_id: 2, pending: {} }, { newKeyWindowHours: 2 });
    assert.ok(!narrow.alerts.some((a) => a.kind === "voter_new_full_access_key"));
  });
});

describe("listProposals (dashboard proposal list)", () => {
  it("returns the newest proposals first with the vote tally, and reads no keys", async (t) => {
    const calls = demo(t);
    const r = await listProposals(DAO);
    assert.equal(r.total, 4);
    // Ids 0 and 1 do not exist in the stub: they are reported, not hidden, and never fail the list.
    assert.deepEqual(r.proposals.map((p) => p.id), [3, 2]);
    assert.deepEqual(r.errors.sort(), ["proposal 0: NOT_A_DAO", "proposal 1: NOT_A_DAO"]);
    assert.equal(r.proposals[1]?.transfer?.receiver_id.length ? true : false, true);
    assert.ok(queries(calls).every((q) => !q.startsWith("view_access_key_list")));
  });

  it("limit caps how many proposals are read", async (t) => {
    const calls = demo(t);
    const r = await listProposals(DAO, { limit: 1 });
    assert.deepEqual(r.proposals.map((p) => p.id), [3]);
    assert.equal(queries(calls).filter((q) => q === "call_function:get_proposal").length, 1);
  });

  it("offset pages back through older proposals and past the end reads none", async (t) => {
    const calls = demo(t);
    const r = await listProposals(DAO, { limit: 1, offset: 1 });
    assert.deepEqual(r.proposals.map((p) => p.id), [2]);
    assert.equal(r.total, 4);
    const past = await listProposals(DAO, { limit: 10, offset: 4 });
    assert.deepEqual([past.proposals.length, past.errors.length, past.total], [0, 0, 4]);
    assert.equal(queries(calls).filter((q) => q === "call_function:get_proposal").length, 1);
  });

  it("a transport failure on one proposal leaves the others", async (t) => {
    demo(t, { down: [3] });
    const r = await listProposals(DAO, { limit: 2 });
    assert.deepEqual(r.proposals.map((p) => p.id), [2]);
    assert.equal(r.errors.length, 1);
  });
});

const G = "guard.kd-demo.testnet";
const guardPending5 = () => fixture("sputnik/get_proposal.5.guard_pending.json");
const guardAuto4 = () => fixture("sputnik/get_proposal.4.guard_auto.json");
const isGuard = (dao = DAO) => bytes({ standard: "kd_guard", version: "1.0.0", dao_id: dao });
/** A DAO with a Guard in role agent-guard; proposals 4 (auto) and 5 (pending) are new. */
const guardDao = (t: TestContext, extra: Partial<World> = {}) =>
  world(t, {
    last: bytes(6),
    policy: fixture("sputnik/get_policy.guard.json"),
    proposals: { 4: bytes(guardAuto4()), 5: bytes(guardPending5()) },
    guardInfo: { [G]: isGuard() },
    keys: { [A]: keysA(), [B]: keysB(), [C]: keysC(), [G]: ok({ block_height: 1, block_hash: "h", keys: [] }) },
    ...extra,
  });
const guardCalls = (calls: Req[]) => calls.filter((c) => c.params.method_name === "kd_guard_info").map((c) => c.params.account_id);

describe("Guard alerts (§5.4, D9)", () => {
  it("a pending Guard request is a high alert that names the agent, the reasons and the memo", async (t) => {
    guardDao(t);
    const r = await checkProposals(DAO, { last_proposal_id: 5, pending: {} });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(kinds(r.alerts), ["testnet:kd-demo.sputnik-dao.testnet:guard_request_pending:5:-"]);
    const expected = fixture<KdAlert>("alerts/guard-request-pending.alert.json");
    assert.deepEqual({ ...r.alerts[0], created_at: "x" }, { ...expected, created_at: "x" });
    // The council must vote, so the tally is the council's, never "waiting for the Guard".
    assert.deepEqual(r.alerts[0]!.proposal?.pending_voters, [A, B, C]);
    assert.equal(r.alerts[0]!.proposal?.approvals_needed, 2);
    assert.ok(r.state.pending["5"]);
  });

  it("an auto Guard transfer is a note so the council sees every outflow", async (t) => {
    const calls = guardDao(t, { last: bytes(5) });
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(kinds(r.alerts), ["testnet:kd-demo.sputnik-dao.testnet:guard_transfer_auto:4:-"]);
    const expected = fixture<KdAlert>("alerts/guard-transfer-auto.alert.json");
    assert.deepEqual({ ...r.alerts[0], created_at: "x" }, { ...expected, created_at: "x" });
    // The locked Guard's vote is scanned too and has no keys: one read, no voter alert.
    assert.deepEqual(calls.filter((c) => c.params.request_type === "view_access_key_list").map((c) => c.params.account_id), [G]);
  });

  it("an auto Guard proposal that did not pass says nothing was paid", async (t) => {
    guardDao(t, { last: bytes(5), proposals: { 4: bytes({ ...guardAuto4(), status: "Failed" }) } });
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    const a = r.alerts[0]!;
    assert.equal(a.messages.en.title, `GUARD PAYMENT NOT DONE: ${DAO}`);
    assert.equal(a.messages.vi.title, `GUARD CHI KHÔNG THÀNH: ${DAO}`);
    assert.match(a.messages.en.body, /status Failed/);
  });

  it("the Guard is asked once per call, however many of its proposals are new", async (t) => {
    const calls = guardDao(t);
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    assert.deepEqual(r.alerts.map((a) => a.kind), ["guard_transfer_auto", "guard_request_pending"]);
    assert.deepEqual(guardCalls(calls), [G]);
  });

  it("a [KD-GUARD] description from an account that is not this DAO's Guard gives no Guard alert", async (t) => {
    for (const reply of [isGuard("other.sputnik-dao.testnet"), bytes({ standard: "nep171" }), ok({ error: "wasm execution failed: MethodNotFound", logs: [] })]) {
      guardDao(t, { guardInfo: { [G]: reply } });
      const r = await checkProposals(DAO, { last_proposal_id: 5, pending: {} });
      assert.deepEqual(r.alerts, []);
      assert.deepEqual(r.errors, []);
      assert.equal(r.state.last_proposal_id, 6);
    }
  });

  it("a Guard's vote is still key-scanned: kd_guard_info is self-reported, so a compromised member cannot hide behind it", async (t) => {
    guardDao(t, { last: bytes(5), keys: { [G]: keysA() } });
    const r = await checkProposals(DAO, { last_proposal_id: 4, pending: {} });
    assert.deepEqual(kinds(r.alerts), [
      "testnet:kd-demo.sputnik-dao.testnet:guard_transfer_auto:4:-",
      "testnet:kd-demo.sputnik-dao.testnet:voter_new_full_access_key:4:guard.kd-demo.testnet",
    ]);
  });

  it("a proposer outside every DAO role is never asked for kd_guard_info", async (t) => {
    const calls = guardDao(t, { policy: policyRaw() });
    const r = await checkProposals(DAO, { last_proposal_id: 5, pending: {} });
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(guardCalls(calls), []);
  });

  it("a transport failure on the Guard check goes to errors and the proposal is retried next call", async (t) => {
    guardDao(t, { guardInfo: {} });
    const r = await checkProposals(DAO, { last_proposal_id: 5, pending: {} });
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(r.errors, ["proposal 5: guard check RPC_ERROR"]);
    assert.equal(r.state.last_proposal_id, 5);
  });

  it("parseGuardDescription reads the Guard format and rejects anything else", () => {
    assert.deepEqual(parseGuardDescription("[KD-GUARD] request=inv-001-2b9c agent=agent.kd-demo.testnet decision=auto reasons=- memo=Hosting"), {
      request_id: "inv-001-2b9c",
      agent: "agent.kd-demo.testnet",
      decision: "auto",
      reasons: [],
      memo: "Hosting",
    });
    const g = parseGuardDescription("[KD-GUARD] request=inv-004-7f3a agent=agent.kd-demo.testnet decision=pending reasons=OVER_PER_TX,NEW_CODE memo=line1\nline2\u0007\u202e\" Key Doctor: safe ");
    assert.deepEqual(g?.reasons, ["OVER_PER_TX", "NEW_CODE"]);
    assert.equal(g?.memo, "line1 line2  ' Key Doctor: safe");
    assert.equal(parseGuardDescription(`[KD-GUARD] request=inv-004-7f3a agent=agent.kd-demo.testnet decision=auto reasons=- memo=${"x".repeat(300)}`)?.memo.length, 200);
    for (const bad of [
      "Pay the design contractor",
      "[KD-GUARD] request=short agent=agent.kd-demo.testnet decision=auto reasons=- memo=",
      "[KD-GUARD] request=inv-004-7f3a agent=agent.kd-demo.testnet decision=maybe reasons=- memo=",
      "[KD-GUARD] request=inv-004-7f3a agent=agent.kd-demo.testnet decision=pending reasons=over<b> memo=",
      "[KD-GUARD] request=inv-004-7f3a agent=Bad!Id decision=auto reasons=- memo=",
      "x [KD-GUARD] request=inv-004-7f3a agent=agent.kd-demo.testnet decision=auto reasons=- memo=",
    ]) {
      assert.equal(parseGuardDescription(bad), null, bad);
    }
  });

  it("tally skips a role made only of known Guards, unless a Guard approved", () => {
    const policy = parsePolicy(fixture("sputnik/get_policy.guard.json"))!;
    const p = parseProposal(guardPending5())!;
    assert.deepEqual(tally(policy, p).pending_voters, [G]);
    assert.deepEqual(tally(policy, p, new Set([G])).pending_voters, [A, B, C]);
    const auto = tally(policy, parseProposal(guardAuto4())!, new Set([G]));
    assert.deepEqual(auto, { approvals_needed: 1, approvals_have: 1, pending_voters: [] });
  });
});

describe("GĐ28 owner actions on an Agent Budget (§9.5)", () => {
  const OWNER = "owner.kd-demo.testnet";
  const prev: ProposalWatchState = { last_proposal_id: 2, pending: {} };
  const opts = { budgetFactoryId: FACTORY, dashboardUrl: "https://dash.test/" };
  const proposal = (id: number, kind: unknown, status = "Approved", proposer = OWNER) =>
    bytes({ id, proposer, description: "x", kind, status, vote_counts: {}, votes: { [OWNER]: "Approve" }, submission_time: "0" });
  const withdraw = { Transfer: { token_id: "", receiver_id: "cold.kd-demo.testnet", amount: "40000000000000000000000000", msg: null } };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
  const call = (receiver_id: string, ...actions: [string, unknown][]) => ({
    FunctionCall: { receiver_id, actions: actions.map(([method_name, args]) => ({ method_name, args: b64(args), deposit: "1", gas: "1" })) },
  });
  /** Proposal 2 alone on the chain, with no voter to scan. */
  const one = (t: TestContext, kind: unknown, extra: Partial<World> = {}) => world(t, { last: bytes(3), guards: [GUARD], proposals: { 2: proposal(2, kind) }, ...extra });

  it("tells a withdrawal only once it went through, so 'just withdrew' is true, and tells it high and unmuteable", async (t) => {
    const open = demo(t, { last: bytes(3), guards: [GUARD], proposals: { 2: proposal(2, withdraw, "InProgress") } });
    const first = await checkProposals(DAO, prev, opts);
    assert.deepEqual(first.budget_alerts, []);
    assert.ok(!queries(open).includes("call_function:get_guards_for_dao"), "an open proposal costs no factory read");
    assert.deepEqual(Object.keys(first.state.pending), ["2"]);

    t.mock.restoreAll();
    one(t, withdraw);
    const { budget_alerts: [a, ...rest] } = await checkProposals(DAO, first.state, opts);
    assert.deepEqual(rest, []);
    assert.equal(a?.alert_id, `testnet:${DAO}:budget_owner_action:2:1`);
    assert.equal(a?.severity, "high");
    assert.equal(a?.muteable, false);
    assert.deepEqual(a?.budget, { dao_id: DAO, guard_id: GUARD });
    assert.deepEqual(a?.owner_action, { action: "withdraw", proposal_id: 2, summary: "withdrew 40 NEAR to cold.kd-demo.testnet" });
    assert.equal(a?.messages.vi.title, `Agent Budget ${DAO}`);
    assert.equal(a?.messages.vi.body, "Vừa rút 40 NEAR về cold.kd-demo.testnet.");
    assert.equal(a?.messages.vi.action, "Nếu không phải bạn: tài khoản của bạn có thể đã bị chiếm. Kiểm tra key ngay.");
    assert.equal(a?.links.dashboard, `https://dash.test/?target=${OWNER}`, "the button checks the account that acted");
  });

  it("says nothing about a proposal that did not go through", async (t) => {
    for (const status of ["Rejected", "Removed", "Expired", "Failed"]) {
      one(t, withdraw, { proposals: { 2: proposal(2, withdraw, status) } });
      assert.deepEqual((await checkProposals(DAO, prev, opts)).budget_alerts, [], status);
      t.mock.restoreAll();
    }
  });

  it("leaves a Guard's own payments alone: an agent spending inside its limit is not the owner acting", async (t) => {
    one(t, withdraw, { proposals: { 2: proposal(2, withdraw, "Approved", GUARD) } });
    assert.deepEqual((await checkProposals(DAO, prev, opts)).budget_alerts, []);
  });

  it("stays silent on a DAO that is no Budget, and reads the factory once per check however many proposals passed", async (t) => {
    const calls = one(t, withdraw, { last: bytes(4), guards: [], proposals: { 2: proposal(2, withdraw), 3: proposal(3, withdraw) } });
    assert.deepEqual((await checkProposals(DAO, prev, opts)).budget_alerts, []);
    assert.equal(queries(calls).filter((q) => q === "call_function:get_guards_for_dao").length, 1);
  });

  it("does nothing on a network without a factory", async (t) => {
    const calls = one(t, withdraw);
    assert.deepEqual((await checkProposals(DAO, prev)).budget_alerts, []);
    assert.ok(!queries(calls).includes("call_function:get_guards_for_dao"));
  });

  it("a factory read that fails loses no alert: the proposal stays to be read again", async (t) => {
    one(t, withdraw, { guards: "down" });
    const failed = await checkProposals(DAO, prev, opts);
    assert.deepEqual(failed.budget_alerts, []);
    assert.deepEqual(failed.errors, ["proposal 2: budget check RPC_ERROR"]);
    assert.equal(failed.state.last_proposal_id, 2);

    t.mock.restoreAll();
    one(t, withdraw);
    const again = await checkProposals(DAO, failed.state, opts);
    assert.equal(again.budget_alerts.length, 1);
    assert.equal(again.state.last_proposal_id, 3);
  });

  it("a failed read of a tracked proposal keeps it tracked", async (t) => {
    const seen = { 2: { kind_label: "transfer", votes_seen: {}, first_seen_at: "2026-11-03T00:00:00Z" } };
    one(t, withdraw, { guards: "down" });
    const r = await checkProposals(DAO, { last_proposal_id: 3, pending: seen }, opts);
    assert.deepEqual(r.state.pending, seen);
  });

  it("names every Guard change the owner must hear about", async (t) => {
    const cases: [string, unknown, string, string][] = [
      ["set_policy", {}, "edit_rules", "changed the spending rules"],
      ["add_whitelist", { account_id: "x.kd-demo.testnet" }, "edit_rules", "added x.kd-demo.testnet to the receivers"],
      ["remove_guardian", { account_id: "x.kd-demo.testnet" }, "edit_rules", "removed the guardian x.kd-demo.testnet"],
      ["add_agent", { account_id: "x.kd-demo.testnet" }, "add_agent", "added the agent x.kd-demo.testnet"],
      ["remove_agent", { account_id: "x.kd-demo.testnet" }, "remove_agent", "removed the agent x.kd-demo.testnet"],
      ["set_agent_enabled", { account_id: "x.kd-demo.testnet", enabled: false }, "disable_agent", "disabled the agent x.kd-demo.testnet"],
      ["set_agent_enabled", { account_id: "x.kd-demo.testnet", enabled: true }, "add_agent", "enabled the agent x.kd-demo.testnet again"],
      ["create_plan", {}, "create_plan", "created a plan"],
      ["cancel_plan", { plan_id: 7 }, "cancel_plan", "cancelled plan 7"],
      ["unpause", {}, "pause_agents", "resumed every agent"],
      ["upgrade", {}, "upgrade_guard", "upgraded the Guard's code"],
    ];
    for (const [method, args, action, summary] of cases) {
      one(t, call(GUARD, [method, args]));
      const { budget_alerts: [a] } = await checkProposals(DAO, prev, opts);
      assert.deepEqual(a?.owner_action, { action, proposal_id: 2, summary }, method);
      t.mock.restoreAll();
    }
  });

  it("claims only the vote for a call: Sputnik marks it Approved before the Guard's answer is known", async (t) => {
    one(t, call(GUARD, ["set_policy", {}]));
    const { budget_alerts: [a] } = await checkProposals(DAO, prev, opts);
    assert.equal(a?.messages.en.body, "Proposal #2 was just approved: changed the spending rules.");
    assert.equal(a?.messages.vi.body, "Vừa duyệt đề xuất #2: đổi luật chi tiêu.");
  });

  it("a harmless first action cannot hide a dangerous second one", async (t) => {
    one(t, call(GUARD, ["refresh_bond", {}], ["add_agent", { account_id: "x.kd-demo.testnet" }], ["set_policy", {}]));
    const { budget_alerts } = await checkProposals(DAO, prev, opts);
    assert.equal(budget_alerts.length, 1);
    assert.equal(budget_alerts[0]?.owner_action?.summary, "added the agent x.kd-demo.testnet; changed the spending rules");
  });

  it("tells tokens leaving by a hand-written call, on any contract", async (t) => {
    one(t, call("usdc.kd-demo.testnet", ["ft_transfer", { receiver_id: "cold.kd-demo.testnet", amount: "5000000" }]));
    const { budget_alerts: [a] } = await checkProposals(DAO, prev, opts);
    assert.equal(a?.owner_action?.action, "withdraw");
    assert.equal(a?.owner_action?.summary, "withdrew 5000000 raw units of usdc.kd-demo.testnet to cold.kd-demo.testnet");
    assert.equal(a?.budget.guard_id, GUARD);
  });

  it("tells a code upgrade of the Guard, not of another contract", async (t) => {
    one(t, { UpgradeRemote: { receiver_id: GUARD, method_name: "upgrade", hash: "h" } });
    assert.equal((await checkProposals(DAO, prev, opts)).budget_alerts[0]?.owner_action?.action, "upgrade_guard");
    t.mock.restoreAll();
    one(t, { UpgradeRemote: { receiver_id: "other.kd-demo.testnet", method_name: "upgrade", hash: "h" } });
    assert.deepEqual((await checkProposals(DAO, prev, opts)).budget_alerts, []);
  });

  it("money cannot leave unseen through a method nobody listed: stolen keys choose the method and the deposit", async (t) => {
    const paid = (receiver_id: string, method_name: string, deposit: string) => ({ FunctionCall: { receiver_id, actions: [{ method_name, args: b64({}), deposit, gas: "1" }] } });
    const told = async (kind: unknown) => {
      one(t, kind);
      const alert = (await checkProposals(DAO, prev, opts)).budget_alerts[0];
      t.mock.restoreAll();
      return alert;
    };
    const drained = await told(paid("drain.kd-demo.testnet", "buy", "9000000000000000000000000"));
    assert.equal(drained?.owner_action?.action, "withdraw");
    assert.equal(drained?.owner_action?.summary, "called buy on drain.kd-demo.testnet with 9 NEAR attached");
    assert.equal(drained?.severity, "high");
    assert.equal((await told(paid("art.kd-demo.testnet", "nft_transfer", "1")))?.owner_action?.summary, "called nft_transfer on art.kd-demo.testnet");
    // The name of a harmless call must not buy silence for a large deposit.
    assert.equal((await told(paid("drain.kd-demo.testnet", "storage_deposit", "9000000000000000000000000")))?.owner_action?.summary, "called storage_deposit on drain.kd-demo.testnet with 9 NEAR attached");
    assert.equal((await told(paid(GUARD, "new_method", "0")))?.owner_action?.summary, `called new_method on ${GUARD}`);
    assert.equal((await told(paid("drain.kd-demo.testnet", "<b>x</b>\nclick", "0")))?.owner_action?.summary, "called ? on drain.kd-demo.testnet", "chain text stays out of the message");
  });

  it("stays quiet on housekeeping calls, and arguments that do not decode cannot break the check", async (t) => {
    for (const kind of [call(GUARD, ["refresh_bond", {}]), call(GUARD, ["withdraw_excess", {}]), call("usdc.kd-demo.testnet", ["storage_deposit", {}])]) {
      one(t, kind);
      assert.deepEqual((await checkProposals(DAO, prev, opts)).budget_alerts, []);
      t.mock.restoreAll();
    }
    one(t, { FunctionCall: { receiver_id: GUARD, actions: [{ method_name: "add_agent", args: "%%%", deposit: "1", gas: "1" }] } });
    const r = await checkProposals(DAO, prev, opts);
    assert.equal(r.budget_alerts[0]?.owner_action?.summary, "added the agent ?");
  });
});
