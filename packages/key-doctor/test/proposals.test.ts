import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { checkProposals, listProposals, type KdAlert, type ProposalWatchState } from "../src/index.ts";
import { actionText, groupOf, parseProposal, tally } from "../src/proposals.ts";
import { parsePolicy } from "../src/parse.ts";
import { blockBody, fixture, installFetch, ok, rpcErr, type Req } from "./support/stub.ts";

const DAO = "kd-demo.sputnik-dao.testnet";
const A = "a.kd-demo.testnet";
const B = "b.kd-demo.testnet";
const C = "c.kd-demo.testnet";

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
}

function world(t: TestContext, w: World): Req[] {
  return installFetch(t, (req) => {
    if (req.method === "block") return blockBody();
    const p = req.params;
    if (p.request_type === "view_access_key_list") return w.keys?.[String(p.account_id)] ?? rpcErr("UNKNOWN_ACCOUNT");
    if (p.request_type === "view_account") return ok({ amount: "1" });
    if (p.request_type === "call_function" && p.account_id === DAO) {
      if (p.method_name === "get_last_proposal_id") return w.last === undefined ? bytes(4) : w.last;
      if (p.method_name === "get_policy") return bytes(policyRaw());
      if (p.method_name === "get_proposal") {
        const { id } = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString()) as { id: number };
        if (w.down?.includes(id)) return new Response("{}", { status: 500 });
        const found = w.proposals?.[id];
        return found === undefined ? ok({ error: "wasm execution failed: ERR_NO_PROPOSAL", logs: [] }) : found;
      }
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
    assert.deepEqual(r, { alerts: [], state: { last_proposal_id: 4, pending: {} }, errors: [] });
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
    oldKeyA.result.keys = oldKeyA.result.keys.filter((k: any) => k.access_key.nonce !== 182330555000000);
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

  it("a transport failure on one proposal leaves the others", async (t) => {
    demo(t, { down: [3] });
    const r = await listProposals(DAO, { limit: 2 });
    assert.deepEqual(r.proposals.map((p) => p.id), [2]);
    assert.equal(r.errors.length, 1);
  });
});
