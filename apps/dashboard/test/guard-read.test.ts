import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { readGuardDao } from "../src/guard-read.ts";

const DAO = "demo.sputnikv2.testnet";
const FACTORY = "guards.kd-demo.testnet";
const GUARD = "ops.guards.kd-demo.testnet";
const PENDING = "new.guards.kd-demo.testnet";
const HEIGHT = 1234;
const CODE_STORAGE = "2483120000000000000000000";

const POLICY = {
  roles: [{ name: "agent-guard", kind: { Group: [GUARD] }, permissions: ["transfer:AddProposal"], vote_policy: {} }],
  proposal_bond: "100000000000000000000000",
};

type Views = Record<string, unknown>;
interface Call {
  method: string;
  account?: string;
  view?: string;
  block?: unknown;
}

/** Answers like a NEAR RPC node: `views` maps "account.method" to the JSON result; a missing entry is a contract failure. */
function stubRpc(views: Views): Call[] {
  const calls: Call[] = [];
  const encode = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
  mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    if (method === "block") {
      calls.push({ method });
      return Response.json({ jsonrpc: "2.0", id: "kd", result: { header: { height: HEIGHT, timestamp_nanosec: "1" } } });
    }
    const key = `${params.account_id}.${params.method_name}`;
    calls.push({ method, account: params.account_id as string, view: params.method_name as string, block: params.block_id });
    if (!(key in views)) {
      return Response.json({ jsonrpc: "2.0", id: "kd", error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR" } } });
    }
    return Response.json({ jsonrpc: "2.0", id: "kd", result: { result: encode(views[key]), logs: [], block_height: HEIGHT } });
  });
  return calls;
}

const baseViews = (over: Views = {}): Views => ({
  [`${DAO}.get_policy`]: POLICY,
  [`${FACTORY}.get_guards_for_dao`]: [
    { guard_id: GUARD, name: "ops", ready: true },
    { guard_id: PENDING, name: "new", ready: false },
  ],
  [`${FACTORY}.kd_factory_metadata`]: { guard_code_storage: CODE_STORAGE },
  [`${GUARD}.get_config`]: { paused: false, proposal_bond: "0", agents: 1, whitelist: 2, guardians: [] },
  [`${GUARD}.get_agents`]: [{ account_id: "agent.testnet", label: "bot", enabled: true, pending: 0 }],
  ...over,
});

afterEach(() => mock.restoreAll());

describe("readGuardDao", () => {
  it("passes the factory's code storage through so the P1 deposit pays the Guard's own code copy", async () => {
    stubRpc(baseViews());
    const state = await readGuardDao(DAO, FACTORY, "testnet");
    assert.equal(state.code_storage, CODE_STORAGE);
    assert.equal(state.dao, DAO);
    assert.equal(state.factory, FACTORY);
  });

  it("pins every view of one page load to the same block, like a scan", async () => {
    const calls = stubRpc(baseViews());
    await readGuardDao(DAO, FACTORY, "testnet");
    const queries = calls.filter((c) => c.method === "query");
    assert.ok(queries.length >= 3);
    assert.ok(queries.every((c) => c.block === HEIGHT));
  });

  it("marks role membership from the DAO policy and never queries a Guard still being created", async () => {
    const calls = stubRpc(baseViews());
    const { guards } = await readGuardDao(DAO, FACTORY, "testnet");
    const [ops, pending] = guards;
    assert.equal(ops?.in_role, true);
    assert.equal(pending?.in_role, false);
    assert.equal(pending?.config, null);
    assert.ok(!calls.some((c) => c.account === PENDING));
  });

  it("keeps a Guard whose view fails, with that field null, so one broken view hides nothing else", async () => {
    stubRpc(baseViews());
    const ops = (await readGuardDao(DAO, FACTORY, "testnet")).guards[0];
    assert.equal(ops?.config?.whitelist, 2);
    assert.equal(ops?.agents?.length, 1);
    assert.equal(ops?.policy, null);
    assert.equal(ops?.window, null);
  });

  // The contract returns `resets_at` in nanoseconds; the card printed "resets 1793762439898342064" before this.
  it("turns the window's nanosecond reset time into ISO UTC for the card", async () => {
    stubRpc(baseViews({ [`${GUARD}.get_window`]: { window_start: "0", resets_at: "1793700000000000000", spent_in_window: "0", remaining: "1" } }));
    const ops = (await readGuardDao(DAO, FACTORY, "testnet")).guards[0];
    assert.equal(ops?.window?.resets_at, "2026-11-03T10:00:00.000Z");
    assert.equal(ops?.window?.remaining, "1");
  });

  it("shows the window as unknown when resets_at is not a nanosecond count", async () => {
    stubRpc(baseViews({ [`${GUARD}.get_window`]: { resets_at: "soon", spent_in_window: "0", remaining: "1" } }));
    assert.equal((await readGuardDao(DAO, FACTORY, "testnet")).guards[0]?.window, null);
  });

  // An old factory (global contract) has no guard_code_storage: a deposit built without it would fail on chain.
  it("refuses a factory whose metadata has no guard_code_storage", async () => {
    stubRpc(baseViews({ [`${FACTORY}.kd_factory_metadata`]: { guard_code_hash: "abc" } }));
    await assert.rejects(readGuardDao(DAO, FACTORY, "testnet"), { message: "FACTORY_UNREADABLE" });
  });

  it("refuses a guard_code_storage that is not a yocto digit string, so BigInt never sees a bad value", async () => {
    for (const bad of [2.48312e24, "2.5", "", "-1", null]) {
      stubRpc(baseViews({ [`${FACTORY}.kd_factory_metadata`]: { guard_code_storage: bad } }));
      await assert.rejects(readGuardDao(DAO, FACTORY, "testnet"), { message: "FACTORY_UNREADABLE" }, String(bad));
      mock.restoreAll();
    }
  });

  it("says FACTORY_UNREADABLE when a factory view fails, not NOT_A_DAO about a DAO that is fine", async () => {
    const views = baseViews();
    delete views[`${FACTORY}.kd_factory_metadata`];
    stubRpc(views);
    mock.method(console, "error", () => {});
    await assert.rejects(readGuardDao(DAO, FACTORY, "testnet"), { message: "FACTORY_UNREADABLE" });
  });

  it("says NOT_A_DAO when the account's get_policy is not a Sputnik policy", async () => {
    stubRpc(baseViews({ [`${DAO}.get_policy`]: { owner: "x.testnet" } }));
    await assert.rejects(readGuardDao(DAO, FACTORY, "testnet"), { message: "NOT_A_DAO" });
  });
});
