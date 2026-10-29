import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isKdError, scanDao, type KdReport } from "../src/index.ts";
import { AGE_LIMITATION, RECEIVERS_UNCHECKED_LIMITATION, missingMemberLimitation, rolePolicyLimitation, roleTokenWeightLimitation, roleTransferLimitation } from "../src/messages.ts";
import { MAX_GROUP_ENTRIES, MAX_KEYS, MAX_MEMBERS, MAX_ROLES, REQUEST_BUDGET } from "../src/rules/thresholds.ts";
import {
  HEAD,
  STUB_URL,
  accountBody,
  blockBody,
  causeBody,
  daoAnswers,
  faKey,
  fcKey,
  groupRole,
  http,
  installStub,
  keysBody,
  loadJson,
  policyBody,
  policyOf,
  unknownAccountBody,
  type Answer,
  type Stub,
} from "./stub-rpc.ts";

const DAO = "kd-test.sputnik-dao.testnet";
const m = (i: number | string) => `m${i}.kd-test.testnet`;
const COUNCIL_PERMS = ["*:VoteApprove"];

async function run(answers: Record<string, Answer>, opts: Parameters<typeof scanDao>[1] = {}): Promise<{ report: KdReport; stub: Stub }> {
  const stub = installStub(answers);
  try {
    const report = await scanDao(DAO, opts);
    assert.deepEqual(stub.unmatched, [], "every request must be one the test configured");
    return { report, stub };
  } finally {
    stub.restore();
  }
}

async function runErr(answers: Record<string, Answer>, opts: Parameters<typeof scanDao>[1] = {}) {
  const stub = installStub(answers);
  try {
    await scanDao(DAO, { rpcUrl: STUB_URL, ...opts });
  } catch (e) {
    assert.ok(isKdError(e), `not a KdError: ${String(e)}`);
    return { err: e, stub };
  } finally {
    stub.restore();
  }
  assert.fail("scanDao did not throw");
}

const kinds = (stub: Stub) => stub.requests.map((r) => r.key);
const keyListReads = (stub: Stub) => stub.requests.filter((r) => r.params.request_type === "view_access_key_list").length;
const ruleIds = (r: KdReport) => [...r.members.flatMap((x) => x.flags), ...r.dao_flags].map((f) => f.rule_id);

const ok5 = () => [faKey(), ];
/** Council of `ids`, all voting RoleWeight with the default [1,2]. */
const councilOf = (ids: string[], extraRoles: unknown[] = []) =>
  policyOf([groupRole("council", ids, COUNCIL_PERMS), ...extraRoles]);
const quiet = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, ok5()]));

function kdDemoAnswers(): Record<string, Answer> {
  return {
    block: loadJson("rpc/block.json"),
    [`query/call_function/kd-demo.sputnik-dao.testnet`]: loadJson("rpc/call_function.get_policy.json"),
    "query/view_access_key_list/a.kd-demo.testnet": loadJson("rpc/view_access_key_list.a.json"),
    "query/view_access_key_list/b.kd-demo.testnet": loadJson("rpc/view_access_key_list.b.json"),
    "query/view_access_key_list/c.kd-demo.testnet": loadJson("rpc/view_access_key_list.c.json"),
    "query/view_account/game.kd-demo.testnet": loadJson("rpc/view_account.game.json"),
  };
}

describe("S3-AC1 scanDao on the kd-demo fixtures", () => {
  it("deep-equals dao-kd-demo.report.json except generated_at", async () => {
    const stub = installStub(kdDemoAnswers());
    let report: KdReport;
    try {
      report = await scanDao("kd-demo.sputnik-dao.testnet");
    } finally {
      stub.restore();
    }
    assert.deepEqual(stub.unmatched, []);
    const expected = loadJson<KdReport>("reports/dao-kd-demo.report.json");
    assert.ok(!Number.isNaN(Date.parse(report.generated_at)));
    assert.deepStrictEqual({ ...report, generated_at: "" }, { ...expected, generated_at: "" });
  });

  it("every query after block carries the head block_id, get_policy and receivers too", async () => {
    const stub = installStub(kdDemoAnswers());
    try {
      await scanDao("kd-demo.sputnik-dao.testnet", { blockHeight: 100_000_000 });
    } finally {
      stub.restore();
    }
    const [first, ...rest] = stub.requests;
    assert.equal(first?.method, "block");
    assert.deepEqual(first?.params, { block_id: 100_000_000 });
    // 1 get_policy + 3 key lists + 1 receiver
    assert.equal(rest.length, 5);
    for (const r of rest) assert.equal(r.params.block_id, HEAD, r.key);
    assert.ok(rest.some((r) => r.params.request_type === "call_function"));
    assert.ok(rest.some((r) => r.key === "query/view_account/game.kd-demo.testnet"));
  });

  it("without a block height the block call asks for the final block", async () => {
    const { stub } = await run(daoAnswers(DAO, councilOf([m(1), m(2), m(3)]), quiet([m(1), m(2), m(3)])));
    assert.deepEqual(stub.requests[0]?.params, { finality: "final" });
  });
});

describe("S3-AC5 request limits and caps", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => m(i + 1));

  it("at most 4 requests in flight by default; concurrency 0 clamps to 1, 9 to 8", async () => {
    const members = ids(12);
    const policy = councilOf(members);
    const keys = quiet(members);
    assert.equal((await run(daoAnswers(DAO, policy, keys))).stub.maxInFlight(), 4);
    assert.equal((await run(daoAnswers(DAO, policy, keys), { concurrency: 0 })).stub.maxInFlight(), 1);
    const nine = (await run(daoAnswers(DAO, policy, keys), { concurrency: 9 })).stub.maxInFlight();
    assert.ok(nine > 4 && nine <= 8, `max in flight ${nine}`);
    assert.equal((await run(daoAnswers(DAO, policy, keys), { concurrency: 3 })).stub.maxInFlight(), 3);
  });

  it("21 members with empty key lists cost 44 requests, not more than 45", async () => {
    const members = ids(21);
    const answers = daoAnswers(DAO, councilOf(members), Object.fromEntries(members.map((id) => [id, []])));
    for (const id of members) answers[`query/view_account/${id}`] = accountBody();
    const { report, stub } = await run(answers);
    assert.equal(stub.requests.length, 44);
    assert.ok(stub.requests.length <= REQUEST_BUDGET);
    assert.equal(report.summary.council_size, 21);
    assert.equal(report.summary.members_scanned, 21);
    assert.ok(report.members.every((x) => x.account_kind === "named" && x.error === null && x.status === "ok"));
  });

  it("receivers fill only REQUEST_BUDGET - used slots, in code-unit order; the total is 45", async () => {
    const members = ids(21);
    const answers: Record<string, Answer> = daoAnswers(DAO, councilOf(members), {});
    const receivers: string[] = [];
    members.forEach((id, i) => {
      if (i < 10) {
        answers[`query/view_access_key_list/${id}`] = keysBody([]);
        answers[`query/view_account/${id}`] = accountBody();
      } else {
        const a = `r${i}a.kd-test.testnet`;
        const b = `r${i}b.kd-test.testnet`;
        receivers.push(a, b);
        answers[`query/view_access_key_list/${id}`] = keysBody([fcKey(a, ["go"]), fcKey(b, ["go"])]);
        answers[`query/view_account/${a}`] = accountBody();
        answers[`query/view_account/${b}`] = accountBody();
      }
    });
    const { report, stub } = await run(answers);
    // 1 block + 1 policy + 21 lists + 10 follow-ups = 33 used, 12 slots left.
    assert.equal(stub.requests.length, REQUEST_BUDGET);
    const asked = stub.requests.filter((r) => r.params.account_id?.startsWith("r")).map((r) => r.params.account_id);
    assert.deepEqual([...asked].sort(), [...receivers].sort().slice(0, 12));
    const flat = report.members.flatMap((x) => x.keys);
    const checked = flat.filter((k) => k.receiver_exists === true);
    const unchecked = flat.filter((k) => k.receiver_exists === null);
    assert.equal(checked.length, 12);
    assert.equal(unchecked.length, 10);
    assert.ok(report.limitations.includes(RECEIVERS_UNCHECKED_LIMITATION));
    assert.equal(report.limitations.filter((l) => l === RECEIVERS_UNCHECKED_LIMITATION).length, 1);
    assert.deepEqual(report.errors, []);
  });

  it("22 council members throw LIMIT_EXCEEDED before any key-list read", async () => {
    const { err, stub } = await runErr(daoAnswers(DAO, councilOf(ids(22)), {}));
    assert.equal(err.kd.code, "LIMIT_EXCEEDED");
    assert.equal(err.kd.retryable, false);
    assert.match(err.kd.message.en, new RegExp(String(MAX_MEMBERS)));
    assert.match(err.kd.message.vi, new RegExp(String(MAX_MEMBERS)));
    assert.deepEqual(kinds(stub), ["block", `query/call_function/${DAO}`]);
  });

  it(`more than ${MAX_ROLES} roles throw LIMIT_EXCEEDED before any key-list read`, async () => {
    const roles = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `r${i}`, kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} }));
    const { err, stub } = await runErr(daoAnswers(DAO, policyOf(roles(MAX_ROLES + 1)), {}));
    assert.equal(err.kd.code, "LIMIT_EXCEEDED");
    assert.match(err.kd.message.en, new RegExp(String(MAX_ROLES)));
    assert.equal(keyListReads(stub), 0);
    // exactly MAX_ROLES roles is fine
    const { report } = await run(daoAnswers(DAO, policyOf(roles(MAX_ROLES)), {}));
    assert.equal(report.dao?.roles.length, MAX_ROLES);
  });

  it(`more than ${MAX_GROUP_ENTRIES} raw Group entries (duplicates counted) throw before any key-list read`, async () => {
    const dup = (n: number) => Array.from({ length: n }, () => m(1));
    const over = await runErr(daoAnswers(DAO, councilOf(dup(MAX_GROUP_ENTRIES + 1)), quiet([m(1)])));
    assert.equal(over.err.kd.code, "LIMIT_EXCEEDED");
    assert.match(over.err.kd.message.en, new RegExp(String(MAX_GROUP_ENTRIES)));
    assert.equal(keyListReads(over.stub), 0);
    // the cap counts across roles, council or not
    const split = await runErr(
      daoAnswers(DAO, policyOf([groupRole("a", dup(250), COUNCIL_PERMS), groupRole("b", dup(251), ["*:AddProposal"])]), quiet([m(1)])),
    );
    assert.equal(split.err.kd.code, "LIMIT_EXCEEDED");
    assert.equal(keyListReads(split.stub), 0);
    // exactly the cap is accepted; one distinct council member
    const edge = await run(daoAnswers(DAO, councilOf(dup(MAX_GROUP_ENTRIES)), quiet([m(1)])));
    assert.equal(edge.report.summary.council_size, 1);
    assert.equal(keyListReads(edge.stub), 1);
  });
});

describe("S3-AC5 get_policy errors", () => {
  const withPolicy = (a: Answer): Record<string, Answer> => ({ block: blockBody(), [`query/call_function/${DAO}`]: a });
  const rpcErr = (name: string) => causeBody(name);

  const cases: Array<[string, Answer, string, boolean]> = [
    ["UNKNOWN_ACCOUNT", unknownAccountBody(), "NOT_FOUND", false],
    ["NO_CONTRACT_CODE", rpcErr("NO_CONTRACT_CODE"), "NOT_A_DAO", false],
    ["CONTRACT_EXECUTION_ERROR", rpcErr("CONTRACT_EXECUTION_ERROR"), "NOT_A_DAO", false],
    ["result.error string", { jsonrpc: "2.0", id: "kd", result: { error: "wasm execution failed SECRET_BODY_TEXT", logs: [] } }, "NOT_A_DAO", false],
    ["bytes that are not JSON", { jsonrpc: "2.0", id: "kd", result: { result: [110, 111, 112, 101] } }, "NOT_A_DAO", false],
    ["bytes out of range", { jsonrpc: "2.0", id: "kd", result: { result: [300] } }, "NOT_A_DAO", false],
    ["JSON without a roles array", policyBody({ roles: "x" }), "NOT_A_DAO", false],
    ["JSON array", policyBody([]), "NOT_A_DAO", false],
    ["role with bad kind", policyBody(policyOf([{ name: "x", kind: "Nobody", permissions: [] }])), "NOT_A_DAO", false],
    ["bad default_vote_policy", policyBody({ ...policyOf([]), default_vote_policy: { weight_kind: "RoleWeight" } }), "NOT_A_DAO", false],
    ["GARBAGE_COLLECTED_BLOCK", rpcErr("GARBAGE_COLLECTED_BLOCK"), "RPC_ERROR", false],
    ["some other cause", rpcErr("INTERNAL_ERROR"), "RPC_ERROR", false],
    ["UNKNOWN_BLOCK", rpcErr("UNKNOWN_BLOCK"), "RPC_ERROR", true],
  ];
  for (const [name, answer, code, retryable] of cases) {
    it(`${name} gives ${code}, retryable ${retryable}`, async () => {
      const { err, stub } = await runErr(withPolicy(answer));
      assert.equal(err.kd.code, code);
      assert.equal(err.kd.retryable, retryable);
      assert.equal(keyListReads(stub), 0);
      const dump = JSON.stringify(err.kd) + err.message + String(err.stack?.split("\n")[0]);
      assert.doesNotMatch(dump, /SECRET_BODY_TEXT|KD_FAKE_API_KEY|rpc\.stub/);
      assert.equal(err.cause, undefined);
    });
  }

  it("HTTP 429 gives RATE_LIMITED and HTTP 500 gives RPC_ERROR, both retryable", async () => {
    const a = await runErr(withPolicy(() => http(429)));
    assert.deepEqual([a.err.kd.code, a.err.kd.retryable], ["RATE_LIMITED", true]);
    const b = await runErr(withPolicy(() => http(500)));
    assert.deepEqual([b.err.kd.code, b.err.kd.retryable], ["RPC_ERROR", true]);
  });

  it("with opts.blockHeight, UNKNOWN_BLOCK on the block call is not retryable", async () => {
    const blockFail = await runErr({ block: rpcErr("UNKNOWN_BLOCK") }, { blockHeight: 5 });
    assert.equal(blockFail.err.kd.retryable, false);
  });
});

describe("S3-AC2 council, roles and approvals_needed", () => {
  const A = m("a");
  const B = m("b");
  const C = m("c");
  const D = m("d");
  const weight = (w: string, q = "0") => ({ weight_kind: "RoleWeight", quorum: q, threshold: w });
  const scan = (policy: unknown, members: string[]) => run(daoAnswers(DAO, policy, quiet(members)));

  it("[1,2] on 3 members needs 2; ratio on 4 needs 3; weight is capped at the group size", async () => {
    const three = await scan(councilOf([A, B, C]), [A, B, C]);
    assert.equal(three.report.dao?.transfer_vote_policy[0]?.approvals_needed, 2);
    const four = await scan(councilOf([A, B, C, D]), [A, B, C, D]);
    assert.equal(four.report.dao?.transfer_vote_policy[0]?.approvals_needed, 3);
    const big = await scan(policyOf([groupRole("council", [A, B, C], COUNCIL_PERMS, { transfer: weight("10") })]), [A, B, C]);
    assert.equal(big.report.dao?.transfer_vote_policy[0]?.approvals_needed, 3);
    const small = await scan(policyOf([groupRole("council", [A, B, C], COUNCIL_PERMS, { transfer: weight("1") })]), [A, B, C]);
    assert.equal(small.report.dao?.transfer_vote_policy[0]?.approvals_needed, 1);
  });

  it("the pass threshold is max(quorum, to_weight)", async () => {
    const r = await scan(policyOf([groupRole("council", [A, B, C], COUNCIL_PERMS, { transfer: weight("1", "3") })]), [A, B, C]);
    assert.equal(r.report.dao?.transfer_vote_policy[0]?.approvals_needed, 3);
  });

  it("duplicate Group entries count once in total and in council_size", async () => {
    const r = await scan(councilOf([A, A, B, B]), [A, B]);
    // 2 distinct members, ratio [1,2] -> floor(2/2)+1 = 2
    assert.equal(r.report.dao?.transfer_vote_policy[0]?.approvals_needed, 2);
    assert.equal(r.report.summary.council_size, 2);
    assert.deepEqual(r.report.dao?.roles[0]?.members, [A, A, B, B], "roles echo the raw group list");
  });

  it("dao.roles keeps policy order, lowercase kinds, members only for groups, transfer capability", async () => {
    const policy = policyOf([
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
      { name: "bots", kind: { Member: "1000" }, permissions: ["transfer:VoteReject"], vote_policy: {} },
      groupRole("council", [A, B, C], ["transfer:*"]),
      groupRole("star", [D], ["*:VoteApprove"]),
      groupRole("any", [D], ["*:*"]),
      groupRole("rejecters", [D], ["transfer:VoteReject", "config:VoteApprove"]),
    ]);
    const { report } = await scan(policy, [A, B, C, D]);
    assert.deepEqual(
      report.dao?.roles.map((r) => [r.name, r.kind, r.members.length, r.can_approve_transfer]),
      [["all", "everyone", 0, false], ["bots", "member", 0, false], ["council", "group", 3, true], ["star", "group", 1, true], ["any", "group", 1, true], ["rejecters", "group", 1, false]],
    );
    assert.deepEqual(report.dao?.transfer_vote_policy.map((t) => t.role), ["council", "star", "any"]);
    assert.equal(report.dao?.proposal_bond_yocto, "100000000000000000000000");
    // D reaches the council through "star" and "any"; "rejecters" alone would not.
    assert.equal(report.summary.council_size, 4);
  });

  it("a group that cannot approve transfers or admin changes is not in the council", async () => {
    const policy = policyOf([
      groupRole("council", [A, B, C], COUNCIL_PERMS),
      groupRole("rejecters", [D], ["transfer:VoteReject", "policy:VoteReject", "config:VoteApprove"]),
    ]);
    const { report, stub } = await scan(policy, [A, B, C]);
    assert.equal(report.summary.council_size, 3);
    assert.ok(!kinds(stub).includes(`query/view_access_key_list/${D}`));
  });

  it("Member.roles lists the holding group roles in policy order, once each", async () => {
    const policy = policyOf([groupRole("council", [A, B, C], COUNCIL_PERMS), groupRole("ops", [B, B], COUNCIL_PERMS), groupRole("empty", [], ["*:AddProposal"])]);
    const { report } = await scan(policy, [A, B, C]);
    const roles = Object.fromEntries(report.members.map((x) => [x.account_id, x.roles]));
    assert.deepEqual(roles, { [A]: ["council"], [B]: ["council", "ops"], [C]: ["council"] });
  });

  it("a policy with no transfer or admin role gives council_size 0, status ok, no COUNCIL_SMALL", async () => {
    const { report, stub } = await run(daoAnswers(DAO, policyOf([{ name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} }]), {}));
    assert.equal(report.summary.council_size, 0);
    assert.equal(report.summary.status, "ok");
    assert.deepEqual(report.members, []);
    assert.deepEqual(report.dao_flags, []);
    assert.equal(stub.requests.length, 2);
  });

  it("limitation lines: Everyone and Member roles, token weight, in fixed order, once per role", async () => {
    const tokenPolicy = { transfer: { weight_kind: "TokenWeight", quorum: "0", threshold: "100" } };
    const policy = policyOf([
      { name: "anyone", kind: "Everyone", permissions: ["transfer:VoteApprove", "policy:VoteApprove"], vote_policy: {} },
      { name: "mem", kind: { Member: "5" }, permissions: ["policy_remove_role:VoteApprove"], vote_policy: {} },
      groupRole("tokens", [A], ["transfer:VoteApprove"], tokenPolicy),
      groupRole("council", [B, C, D], COUNCIL_PERMS),
    ]);
    const { report } = await scan(policy, [A, B, C, D]);
    assert.deepEqual(report.limitations, [
      AGE_LIMITATION,
      roleTransferLimitation("anyone"),
      rolePolicyLimitation("anyone"),
      rolePolicyLimitation("mem"),
      roleTokenWeightLimitation("tokens"),
    ]);
    const tw = report.dao?.transfer_vote_policy.find((t) => t.role === "tokens");
    assert.deepEqual([tw?.weight_kind, tw?.threshold, tw?.approvals_needed], ["TokenWeight", "100", null]);
    assert.ok(!report.members.find((x) => x.account_id === A)?.flags.some((f) => f.rule_id === "DAO_ADMIN"));
  });

  it("a token-weight admin label alone gives the token-weight line", async () => {
    const policy = policyOf([groupRole("council", [A, B, C], COUNCIL_PERMS, { policy: { weight_kind: "TokenWeight", quorum: "0", threshold: "1" } })]);
    const { report } = await scan(policy, [A, B, C]);
    assert.ok(report.limitations.includes(roleTokenWeightLimitation("council")));
    assert.ok(!ruleIds(report).includes("DAO_ADMIN"));
  });

  it("role names echo only when plain and short, else #<index+1>", async () => {
    const long = "x".repeat(33);
    const policy = policyOf([
      { name: "ops team_1.0-a", kind: "Everyone", permissions: ["transfer:VoteApprove"], vote_policy: {} },
      { name: "evil\nname", kind: "Everyone", permissions: ["transfer:VoteApprove"], vote_policy: {} },
      { name: long, kind: "Everyone", permissions: ["transfer:VoteApprove"], vote_policy: {} },
      { name: "y".repeat(32), kind: "Everyone", permissions: ["transfer:VoteApprove"], vote_policy: {} },
      groupRole("council", [A, B, C], COUNCIL_PERMS),
    ]);
    const { report } = await scan(policy, [A, B, C]);
    assert.deepEqual(report.limitations.slice(1), [
      roleTransferLimitation("ops team_1.0-a"),
      roleTransferLimitation("#2"),
      roleTransferLimitation("#3"),
      roleTransferLimitation("y".repeat(32)),
    ]);
    assert.ok(!report.limitations.join("").includes("\n"));
  });
});

describe("S3-AC3 DAO rules", () => {
  const A = m("a");
  const B = m("b");
  const C = m("c");
  const adminPolicy = (threshold: string, extra: Record<string, unknown> = {}) =>
    policyOf([groupRole("council", [A, B, C], COUNCIL_PERMS, { policy: { weight_kind: "RoleWeight", quorum: "0", threshold }, ...extra })]);
  const scan = (policy: unknown, keys: Record<string, any[]> = quiet([A, B, C])) =>
    run(daoAnswers(DAO, policy, keys, { "query/view_account/other.sputnik-dao.testnet": accountBody() }));

  it("DAO_ADMIN: every member of a role where 1 vote passes policy changes; none at 2 votes", async () => {
    const one = (await scan(adminPolicy("1"))).report;
    for (const x of one.members) {
      const f = x.flags.find((f) => f.rule_id === "DAO_ADMIN");
      assert.ok(f, x.account_id);
      assert.equal(f.scope, "dao");
      assert.equal(f.severity, "high");
      assert.equal(f.account_id, x.account_id);
      assert.deepEqual(f.evidence, { approvals_needed: 1 });
      assert.equal(x.status, "high");
      assert.ok(x.keys.every((k) => !k.flag_ids.includes("DAO_ADMIN")), "no key ids");
    }
    assert.equal(one.summary.status, "high");
    assert.equal(one.summary.members_high, 3);
    const two = (await scan(adminPolicy("2"))).report;
    assert.ok(!ruleIds(two).includes("DAO_ADMIN"));
    assert.equal(two.summary.status, "note", "only PQ_NONE notes remain");
  });

  it("DAO_ADMIN: any admin label with 1 vote is enough, other labels are not", async () => {
    const hit = (await scan(policyOf([groupRole("council", [A, B, C], ["policy_remove_role:VoteApprove", "transfer:VoteApprove"], { policy_remove_role: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } })]))).report;
    assert.equal(ruleIds(hit).filter((r) => r === "DAO_ADMIN").length, 3);
    // transfer with 1 vote is not a policy change
    const no = (await scan(policyOf([groupRole("council", [A, B, C], COUNCIL_PERMS, { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } })]))).report;
    assert.ok(!ruleIds(no).includes("DAO_ADMIN"));
    // reject / config permissions are not admin approval
    const rej = (await scan(policyOf([groupRole("council", [A, B, C], ["transfer:VoteApprove", "policy:VoteReject", "config:VoteApprove"], { policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } })]))).report;
    assert.ok(!ruleIds(rej).includes("DAO_ADMIN"));
  });

  it("DAO_ADMIN: a quorum above the weight lifts approvals past 1", async () => {
    const r = (await scan(adminPolicy("1", { policy: { weight_kind: "RoleWeight", quorum: "2", threshold: "1" } }))).report;
    assert.ok(!ruleIds(r).includes("DAO_ADMIN"));
  });

  it("DAO_ADMIN: a single-member group passes alone under the default [1,2]", async () => {
    const r = (await run(daoAnswers(DAO, policyOf([groupRole("solo", [A], COUNCIL_PERMS)]), quiet([A])))).report;
    assert.equal(ruleIds(r).filter((x) => x === "DAO_ADMIN").length, 1);
  });

  it("DAO_ADMIN: only the admin role's members are flagged, not other council members", async () => {
    const policy = policyOf([
      groupRole("admins", [A], ["policy:VoteApprove"], { policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } }),
      groupRole("treasury", [B, C], ["transfer:VoteApprove"]),
    ]);
    const { report } = await scan(policy);
    const flagged = report.members.filter((x) => x.flags.some((f) => f.rule_id === "DAO_ADMIN")).map((x) => x.account_id);
    assert.deepEqual(flagged, [A]);
    assert.equal(report.summary.council_size, 3);
  });

  it("FC_DAO_VOTE: fires for act_proposal or any method on the scanned DAO, with evidence any_method", async () => {
    const decoyDao = "other.sputnik-dao.testnet";
    const keys = {
      [A]: [faKey(), fcKey(DAO, ["act_proposal"])],
      [B]: [faKey(), fcKey(DAO, ["add_proposal", "act_proposal"]), fcKey(DAO, [])],
      [C]: [faKey(), fcKey(DAO, ["add_proposal"]), fcKey(decoyDao, ["act_proposal"], "1"), fcKey(decoyDao, [])],
    };
    const { report, stub } = await scan(adminPolicy("2"), keys);
    // receiver == scanned DAO needs no request; the decoy DAO does.
    assert.ok(!kinds(stub).includes(`query/view_account/${DAO}`));
    assert.ok(kinds(stub).includes(`query/view_account/${decoyDao}`));
    const hits = report.members.flatMap((x) => x.flags.filter((f) => f.rule_id === "FC_DAO_VOTE").map((f) => [x.account_id, f.evidence]));
    assert.deepEqual(hits.sort((p, q) => String(p[0]) < String(q[0]) ? -1 : 1), [[A, { any_method: false }], [B, { any_method: false }], [B, { any_method: true }]]);
    const c = report.members.find((x) => x.account_id === C)!;
    assert.ok(!c.flags.some((f) => f.rule_id === "FC_DAO_VOTE"));
    const a = report.members.find((x) => x.account_id === A)!;
    const vote = a.flags.find((f) => f.rule_id === "FC_DAO_VOTE")!;
    assert.equal(vote.scope, "key");
    assert.equal(vote.severity, "high");
    assert.equal(a.status, "high");
    assert.deepEqual(a.keys.map((k) => k.flag_ids.includes("FC_DAO_VOTE")), [false, true]);
    assert.equal(a.keys[1]?.receiver_exists, true);
    assert.match(vote.messages.en.explain, new RegExp(DAO.replaceAll(".", "\\.")));
  });

  it("COUNCIL_SMALL: 1 and 2 members fire in dao_flags with council_size evidence; 3 does not", async () => {
    for (const n of [1, 2]) {
      const ids = [A, B, C].slice(0, n);
      // [1,2] on 1 member makes it an admin too, which is a separate rule.
      const { report } = await run(daoAnswers(DAO, councilOf(ids), quiet(ids)));
      assert.equal(report.dao_flags.length, 1);
      assert.deepEqual([report.dao_flags[0]?.rule_id, report.dao_flags[0]?.severity, report.dao_flags[0]?.scope], ["COUNCIL_SMALL", "note", "dao"]);
      assert.deepEqual(report.dao_flags[0]?.evidence, { council_size: n });
      assert.equal(report.dao_flags[0]?.account_id, undefined);
    }
    const three = (await run(daoAnswers(DAO, councilOf([A, B, C]), quiet([A, B, C])))).report;
    assert.deepEqual(three.dao_flags, []);
  });
});

describe("S3-AC4 member failures, missing members, order, counts", () => {
  const ids = ["a", "b", "c", "d", "e", "f"].map(m);
  const [A, B, C, D, E, F] = ids as [string, string, string, string, string, string];
  const fail500 = () => http(500);

  it("a member key-list failure keeps the member with keys [], flags [], status note and a coded error", async () => {
    const answers = daoAnswers(DAO, councilOf([A, B, C]), { [A]: [faKey()], [C]: [faKey(), faKey(), faKey(), faKey(), faKey()] }, {
      [`query/view_access_key_list/${B}`]: fail500,
    });
    const { report } = await run(answers);
    const b = report.members.find((x) => x.account_id === B)!;
    assert.deepEqual([b.error, b.status, b.keys, b.flags, b.account_kind, b.pq_ready], ["RPC_ERROR", "note", [], [], "named", false]);
    assert.deepEqual(b.counts, { full_access: 0, function_call: 0, ml_dsa: 0, unused: 0 });
    assert.deepEqual(report.errors, [`member ${B}: RPC_ERROR`]);
    assert.equal(report.summary.members_scanned, 2);
    assert.equal(report.summary.council_size, 3);
    assert.equal(report.summary.keys_total, 6);
    assert.equal(report.summary.members_high + report.summary.members_cleanup + report.summary.members_ok, report.summary.members_scanned);
    assert.equal(report.summary.status, "high");
    assert.deepEqual(report.members.map((x) => x.account_id), [C, A, B], "errored members sort last");
  });

  it("HTTP 429 on a member gives RATE_LIMITED; other errors give RPC_ERROR; over MAX_KEYS gives LIMIT_EXCEEDED, keys []", async () => {
    const many = Array.from({ length: MAX_KEYS + 1 }, () => faKey());
    const exactly = Array.from({ length: MAX_KEYS }, () => faKey());
    const answers = daoAnswers(DAO, councilOf([A, B, C, D]), { [C]: many, [D]: exactly }, {
      [`query/view_access_key_list/${A}`]: () => http(429),
      [`query/view_access_key_list/${B}`]: causeBody("INTERNAL_ERROR"),
    });
    const { report, stub } = await run(answers);
    const by = Object.fromEntries(report.members.map((x) => [x.account_id, x]));
    assert.equal(by[A]?.error, "RATE_LIMITED");
    assert.equal(by[B]?.error, "RPC_ERROR");
    assert.equal(by[C]?.error, "LIMIT_EXCEEDED");
    assert.deepEqual(by[C]?.keys, []);
    assert.equal(by[D]?.error, null);
    assert.equal(by[D]?.keys.length, MAX_KEYS);
    assert.deepEqual(report.errors, [A, B, C].map((id, i) => `member ${id}: ${["RATE_LIMITED", "RPC_ERROR", "LIMIT_EXCEEDED"][i]}`));
    assert.ok(!kinds(stub).includes(`query/view_account/${C}`), "no follow-up for a non-empty list");
  });

  it("a missing member (UNKNOWN_ACCOUNT on the key list) is kind missing, no error, status note, with the limitation line", async () => {
    const answers = daoAnswers(DAO, councilOf([A, B, C]), { [A]: [faKey()], [C]: [faKey()] }, {
      [`query/view_access_key_list/${B}`]: unknownAccountBody(),
    });
    const { report } = await run(answers);
    const b = report.members.find((x) => x.account_id === B)!;
    assert.deepEqual([b.account_kind, b.error, b.status, b.flags, b.keys], ["missing", null, "note", [], []]);
    assert.deepEqual(report.errors, []);
    assert.ok(report.limitations.includes(missingMemberLimitation(B)));
    assert.equal(report.limitations.length, 2);
    assert.equal(report.summary.members_scanned, 3, "a missing account still counts as read");
  });

  it("an empty key list is confirmed by view_account: UNKNOWN_ACCOUNT is missing, success is an ok member, other failure is an error", async () => {
    const answers = daoAnswers(DAO, councilOf([A, B, C, D]), { [A]: [], [B]: [], [C]: [], [D]: [faKey()] }, {
      [`query/view_account/${A}`]: unknownAccountBody(),
      [`query/view_account/${B}`]: accountBody(),
      [`query/view_account/${C}`]: fail500,
    });
    const { report } = await run(answers);
    const by = Object.fromEntries(report.members.map((x) => [x.account_id, x]));
    assert.deepEqual([by[A]?.account_kind, by[A]?.error, by[A]?.status], ["missing", null, "note"]);
    assert.deepEqual([by[B]?.account_kind, by[B]?.error, by[B]?.status, by[B]?.keys], ["named", null, "ok", []]);
    assert.deepEqual([by[C]?.error, by[C]?.status], ["RPC_ERROR", "note"]);
    assert.deepEqual(report.limitations, [AGE_LIMITATION, missingMemberLimitation(A)]);
    assert.deepEqual(report.errors, [`member ${C}: RPC_ERROR`]);
  });

  it("all members errored: report returned, members_scanned 0, all counts 0, status note", async () => {
    const answers = daoAnswers(DAO, councilOf([A, B, C]), {}, Object.fromEntries([A, B, C].map((id) => [`query/view_access_key_list/${id}`, fail500])));
    const { report } = await run(answers);
    assert.deepEqual(report.summary, {
      status: "note",
      council_size: 3,
      members_scanned: 0,
      members_high: 0,
      members_cleanup: 0,
      members_ok: 0,
      pq_ready: 0,
      keys_total: 0,
      keys_full_access: 0,
      keys_unused: 0,
    });
    assert.equal(report.members.length, 3);
    assert.ok(report.members.every((x) => x.status === "note" && x.error === "RPC_ERROR"));
    assert.equal(report.errors.length, 3);
    assert.equal(report.dao_flags.length, 0);
  });

  it("all members errored on a council of 2 still reports COUNCIL_SMALL (council_size counts errored members)", async () => {
    const answers = daoAnswers(DAO, councilOf([A, B]), {}, Object.fromEntries([A, B].map((id) => [`query/view_access_key_list/${id}`, fail500])));
    const { report } = await run(answers);
    assert.deepEqual(report.dao_flags.map((f) => f.rule_id), ["COUNCIL_SMALL"]);
    assert.equal(report.summary.members_scanned, 0);
  });

  it("members sort high, cleanup, note, ok, then errored; ties by account id in code-unit order; errors[] follow members then receivers", async () => {
    const hiA = m("a-hi");
    const hiB = m("b-hi");
    const cl = m("c-cl");
    const note = m("d-note");
    const okM = m("e-ok");
    const gone = m("f-gone");
    const err1 = m("g-err");
    const err2 = m("h-err");
    const recvB = "bravo.kd-test.testnet";
    const recvA = "alpha.kd-test.testnet";
    const five = () => [faKey(), faKey(), faKey(), faKey(), faKey()];
    const all = [err2, okM, hiB, gone, cl, err1, note, hiA];
    const answers = daoAnswers(
      DAO,
      councilOf(all),
      {
        [hiA]: five(),
        [hiB]: five(),
        [cl]: [faKey(), faKey()],
        // one ML-DSA key and nothing else: no flags at all
        [note]: [fcKey(recvB, ["go"]), fcKey(recvA, ["go"])],
        [okM]: [faKey(5, 182_000_000, "ml-dsa-65-hash")],
      },
      {
        [`query/view_access_key_list/${gone}`]: unknownAccountBody(),
        [`query/view_access_key_list/${err1}`]: fail500,
        [`query/view_access_key_list/${err2}`]: fail500,
        [`query/view_account/${recvA}`]: fail500,
        [`query/view_account/${recvB}`]: causeBody("INTERNAL_ERROR"),
      },
    );
    const { report } = await run(answers);
    assert.deepEqual(
      report.members.map((x) => [x.account_id, x.status]),
      [[hiA, "high"], [hiB, "high"], [cl, "cleanup"], [note, "note"], [gone, "note"], [okM, "ok"], [err1, "note"], [err2, "note"]],
    );
    assert.deepEqual(report.errors, [`member ${err1}: RPC_ERROR`, `member ${err2}: RPC_ERROR`, `receiver ${recvA}: RPC_ERROR`, `receiver ${recvB}: RPC_ERROR`]);
    const n = report.members.find((x) => x.account_id === note)!;
    assert.deepEqual(n.keys.map((k) => k.receiver_exists), [null, null]);
    assert.equal(report.summary.members_scanned, 6);
    assert.equal(report.summary.members_ok, 3);
    assert.equal(report.summary.members_high, 2);
    assert.equal(report.summary.members_cleanup, 1);
    assert.equal(report.summary.pq_ready, 1);
    assert.equal(report.summary.keys_total, 5 + 5 + 2 + 2 + 1);
    assert.equal(report.summary.keys_full_access, 5 + 5 + 2 + 1);
  });

  it("limitations keep the order age, role lines, missing-member lines, receivers", async () => {
    const answers = daoAnswers(
      DAO,
      councilOf([A, B, C], [{ name: "all", kind: "Everyone", permissions: ["transfer:VoteApprove"], vote_policy: {} }]),
      { [A]: [fcKey("x.kd-test.testnet", ["go"])], [C]: [faKey()] },
      { [`query/view_access_key_list/${B}`]: unknownAccountBody() },
    );
    const { report } = await run(answers, { skipReceiverCheck: true });
    assert.deepEqual(report.limitations, [AGE_LIMITATION, roleTransferLimitation("all"), missingMemberLimitation(B), RECEIVERS_UNCHECKED_LIMITATION]);
  });

  it("an invalid member id is kept with INVALID_ACCOUNT_ID, no request, and a sanitized printable id", async () => {
    const raw = `Bad Id\n\u001b[31mé${"x".repeat(100)}`;
    const answers = daoAnswers(DAO, councilOf([A, raw, B]), { [A]: [faKey()], [B]: [faKey()] });
    const { report, stub } = await run(answers);
    const bad = report.members.find((x) => x.error === "INVALID_ACCOUNT_ID")!;
    assert.equal(bad.status, "note");
    assert.match(bad.account_id, /^[\x21-\x7e]{1,64}$/);
    assert.equal(bad.account_id.length, 64);
    assert.ok(bad.account_id.startsWith("Bad?Id?"));
    assert.ok(!bad.account_id.includes("\n") && !bad.account_id.includes("\u001b"));
    assert.deepEqual(report.errors, [`member ${bad.account_id}: INVALID_ACCOUNT_ID`]);
    assert.equal(stub.requests.filter((r) => r.params.account_id !== undefined && !ids.includes(r.params.account_id) && r.params.account_id !== DAO).length, 0);
    assert.equal(report.summary.members_scanned, 2);
  });

  it("eth_implicit and implicit members are scanned and typed", async () => {
    const eth = `0x${"ab".repeat(20)}`;
    const imp = "cd".repeat(32);
    const { report } = await run(daoAnswers(DAO, councilOf([eth, imp, A]), quiet([eth, imp, A])));
    const kind = Object.fromEntries(report.members.map((x) => [x.account_id, x.account_kind]));
    assert.deepEqual(kind, { [eth]: "eth_implicit", [imp]: "implicit", [A]: "named" });
    assert.ok(report.members.every((x) => x.error === null));
  });

  it("a receiver that fails the id regex is not requested and sets the limitation", async () => {
    const answers = daoAnswers(DAO, councilOf([A, B, C]), { [A]: [fcKey("Not A Valid ID", ["go"])], [B]: [faKey()], [C]: [faKey()] });
    const { report } = await run(answers);
    const k = report.members.find((x) => x.account_id === A)!.keys[0]!;
    assert.equal(k.receiver_exists, null);
    assert.ok(report.limitations.includes(RECEIVERS_UNCHECKED_LIMITATION));
  });

  it("FC_DEAD_RECEIVER: UNKNOWN_ACCOUNT receiver is false and flagged; existing receiver is true", async () => {
    const dead = "dead.kd-test.testnet";
    const live = "live.kd-test.testnet";
    const answers = daoAnswers(DAO, councilOf([A, B, C]), { [A]: [fcKey(dead, ["go"]), fcKey(live, ["go"])], [B]: [faKey()], [C]: [faKey()] }, {
      [`query/view_account/${dead}`]: unknownAccountBody(),
      [`query/view_account/${live}`]: accountBody(),
    });
    const { report } = await run(answers);
    const a = report.members.find((x) => x.account_id === A)!;
    assert.deepEqual(a.keys.map((k) => k.receiver_exists), [false, true]);
    assert.deepEqual(a.keys.map((k) => k.flag_ids.includes("FC_DEAD_RECEIVER")), [true, false]);
  });
});

describe("determinism", () => {
  it("same block and same answers give identical reports apart from generated_at", async () => {
    const scan = async (opts: Parameters<typeof scanDao>[1]) => {
      const stub = installStub(kdDemoAnswers());
      try {
        return await scanDao("kd-demo.sputnik-dao.testnet", opts);
      } finally {
        stub.restore();
      }
    };
    const one = await scan({});
    const two = await scan({ concurrency: 1 });
    assert.deepStrictEqual({ ...one, generated_at: "" }, { ...two, generated_at: "" });
  });
});


