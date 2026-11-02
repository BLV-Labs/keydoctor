import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import { base58Decode, base58Encode, Rpc, type AgentKey } from "../src/near.ts";
import { configFromEnv, createGuard, ToolError, TOOLS } from "../src/tools.ts";

const GUARD = "guard.testnet";
const AGENT = "agent.testnet";
const UUID = "7c1e9f2a-0b5d-4a51-9a1e-2f3c4d5e6f70";
const SEED = Buffer.alloc(32, 7);
const PUB = base58Decode("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
const KEY: AgentKey = { accountId: AGENT, publicKey: "ed25519:" + base58Encode(PUB), pub: PUB, seed: SEED };
const NEAR = (n: string) => n + "0".repeat(24);

interface Record_ {
  request_id: string;
  receiver_id: string;
  amount: string;
  memo: string;
  decision: "Auto" | "Pending";
  reasons: string[];
  proposal_id: number | null;
  status: string;
}

const record = (over: Partial<Record_> = {}): Record_ => ({
  request_id: UUID,
  receiver_id: "vendor.testnet",
  amount: NEAR("2"),
  memo: "INV-001",
  decision: "Auto",
  reasons: [],
  proposal_id: 7,
  status: "AutoApproved",
  ...over,
});

const success = (r: unknown) => ({ result: { status: { SuccessValue: Buffer.from(JSON.stringify(r)).toString("base64") } } });
const panic = (code: string) => ({
  result: { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } } } } } },
});

interface Sent {
  methodName: string;
  args: any;
  nonce: bigint;
  signatureOk: boolean;
}

/** A fake NEAR RPC for the Guard: views from `views`, the access key, and send_tx answered by `onSend`. */
function chain(opts: { views?: Record<string, (args: any) => unknown>; permission?: unknown; onSend?: (s: Sent) => unknown } = {}) {
  let nonce = 42n;
  const sent: Sent[] = [];
  const views: Record<string, (args: any) => unknown> = {
    get_policy: () => ({ max_per_tx: NEAR("5"), max_per_day: NEAR("10"), max_pending_per_agent: 3, min_reserve: NEAR("1") }),
    get_window: () => ({ window_start: "0", resets_at: "1793700000000000000", spent_in_window: "2500000000000000000000000", remaining: "7500000000000000000000000" }),
    get_config: () => ({ dao_id: "dao.sputnik-v2.testnet", paused: false }),
    get_whitelist: () => [{ account_id: "vendor.testnet", label: "Vendor A", max_per_tx: null }],
    get_agents: () => [{ account_id: AGENT, label: "agent", enabled: true, pending: 1 }],
    get_request: () => null,
    ...opts.views,
  };
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (body: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "guard-mcp", ...(body as object) }));
    if (method === "query" && params.request_type === "view_access_key") {
      return reply({ result: { nonce: Number(nonce), permission: opts.permission ?? { FunctionCall: { receiver_id: GUARD } }, block_hash: base58Encode(Buffer.alloc(32, 9)) } });
    }
    if (method === "query" && params.request_type === "call_function") {
      const view = views[params.method_name];
      if (!view) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_METHOD" } } });
      const out = view(JSON.parse(Buffer.from(params.args_base64, "base64").toString()));
      return reply({ result: { result: [...Buffer.from(JSON.stringify(out))] } });
    }
    if (method === "send_tx") {
      const s = decodeSigned(Buffer.from(params.signed_tx_base64, "base64"));
      sent.push(s);
      nonce = s.nonce; // the chain moves the key nonce once the transaction lands
      const r = (opts.onSend ?? (() => success(record())))(s);
      if (r instanceof Error) throw r;
      return reply(r);
    }
    throw new Error(`unexpected RPC ${method}`);
  }) as unknown as typeof fetch;
  const guard = createGuard({
    config: { network: "testnet", rpcUrl: "https://rpc.test", guardId: GUARD, agentId: AGENT, keyPath: "/unused" },
    rpc: new Rpc("https://rpc.test", fetchFn),
    key: KEY,
    newRequestId: () => UUID,
  });
  return { guard, sent };
}

/** Reads back the fields this server writes into one FunctionCall transaction and checks its signature. */
function decodeSigned(signed: Buffer): Sent {
  const body = signed.subarray(0, -65);
  let o = 0;
  const str = () => {
    const n = body.readUInt32LE(o);
    const s = body.subarray(o + 4, o + 4 + n);
    o += 4 + n;
    return s;
  };
  assert.equal(str().toString(), AGENT);
  o += 33; // key type + public key
  const nonce = body.readBigUInt64LE(o);
  o += 8;
  assert.equal(str().toString(), GUARD);
  o += 32 + 4 + 1; // block hash, action count, action tag
  const methodName = str().toString();
  const args = JSON.parse(str().toString());
  assert.ok(body.subarray(o + 8).equals(Buffer.alloc(16)), "no deposit is attached"); // after the u64 gas
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), PUB]), format: "der", type: "spki" });
  const signatureOk = verify(null, createHash("sha256").update(body).digest(), spki, signed.subarray(-64));
  return { methodName, args, nonce, signatureOk };
}

describe("guard_request_transfer", () => {
  it("signs request_transfer with a server-made request_id and the exact yocto amount", async () => {
    const { guard, sent } = chain();
    const r = await guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "2.5", memo: "INV-001" });
    assert.equal(sent.length, 1);
    const tx = sent[0]!;
    assert.ok(tx.signatureOk);
    assert.equal(tx.methodName, "request_transfer");
    assert.equal(tx.nonce, 43n);
    assert.deepEqual(tx.args, { request_id: UUID, receiver_id: "vendor.testnet", amount: "2500000000000000000000000", memo: "INV-001" });
    assert.equal(r.request_id, UUID);
    assert.match(r.tx_hash!, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("maps an auto-approved record to auto_approved with limits read from the Guard", async () => {
    const { guard } = chain();
    const r = await guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "2" });
    assert.equal(r.schema_version, "kd.guard_result.v1");
    assert.equal(r.status, "auto_approved");
    assert.equal(r.proposal_id, 7);
    assert.equal(r.error_code, null);
    // remaining_today must be the Guard's own window, not something the server computes.
    assert.deepEqual(r.limits, { max_per_tx: "5", max_per_day: "10", remaining_today: "7.5" });
    assert.match(r.message, /Do not send it again/);
  });

  it("maps Pending with its reasons and tells the agent not to resend or split", async () => {
    const pending = record({ receiver_id: "attacker.testnet", amount: NEAR("500"), decision: "Pending", reasons: ["NOT_WHITELISTED", "OVER_PER_TX"], proposal_id: 57, status: "Pending" });
    const { guard } = chain({ onSend: () => success(pending) });
    const r = await guard.requestTransfer({ receiver_id: "attacker.testnet", amount_near: "500" });
    assert.equal(r.status, "pending");
    assert.equal(r.proposal_id, 57);
    assert.deepEqual(r.reasons, ["NOT_WHITELISTED", "OVER_PER_TX"]);
    assert.equal(r.error_code, null);
    assert.match(r.message, /Do NOT send it again/);
    assert.match(r.message, /do NOT split/);
    assert.match(r.message, /council/);
    assert.match(r.message, new RegExp(`guard_get_request_status and request_id ${UUID}`));
  });

  for (const code of ["PAUSED", "UNKNOWN_AGENT", "AGENT_DISABLED", "INVALID_REQUEST_ID", "DUPLICATE_REQUEST", "INVALID_AMOUNT", "TOO_MANY_PENDING", "INSUFFICIENT_GUARD_BALANCE"]) {
    it(`maps the contract error ${code} to rejected`, async () => {
      const { guard } = chain({ onSend: () => panic(code) });
      const r = await guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "1" });
      assert.equal(r.status, "rejected");
      assert.equal(r.error_code, code);
      assert.equal(r.proposal_id, null);
      assert.ok(r.tx_hash);
      assert.match(r.message, /Do not send this payment again in another form/);
    });
  }

  it("reports a Failed record as failed, since the proposal may still be open", async () => {
    const { guard } = chain({ onSend: () => success(record({ status: "Failed" })) });
    const r = await guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "1" });
    assert.equal(r.status, "failed");
    assert.equal(r.error_code, "REQUEST_FAILED");
    assert.match(r.message, /proposal 7 may still be open/);
  });

  it("on a lost answer says the outcome is unknown and points to the status tool instead of a resend", async () => {
    for (const fail of [new TypeError("fetch failed"), { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }]) {
      const { guard } = chain({ onSend: () => fail });
      const r = await guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "1" });
      assert.equal(r.status, "failed");
      assert.equal(r.error_code, "UNKNOWN_OUTCOME");
      assert.ok(r.tx_hash, "the hash is known before sending");
      assert.match(r.message, /Do NOT send a new request: check with guard_get_request_status/);
    }
  });

  it("says nothing was sent when the key is out of allowance", async () => {
    const err = {
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "INVALID_TRANSACTION" },
        data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { NotEnoughAllowance: { allowance: "1" } } } } },
      },
    };
    const { guard } = chain({ onSend: () => err });
    const r = await guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "1" });
    assert.equal(r.error_code, "NOT_ENOUGH_ALLOWANCE");
    assert.equal(r.tx_hash, null);
  });

  it("refuses to sign with a full-access key", async () => {
    const { guard, sent } = chain({ permission: "FullAccess" });
    await assert.rejects(guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "1" }), (e: ToolError) => e.code === "FULL_ACCESS_KEY");
    assert.equal(sent.length, 0);
  });

  it("validates input before signing anything", async () => {
    const { guard, sent } = chain();
    const bad: [Record<string, unknown>, string][] = [
      [{ receiver_id: "vendor.testnet", amount_near: "1e3" }, "INVALID_AMOUNT"],
      [{ receiver_id: "vendor.testnet", amount_near: "-1" }, "INVALID_AMOUNT"],
      [{ receiver_id: "vendor.testnet", amount_near: "0.0" }, "INVALID_AMOUNT"],
      [{ receiver_id: "vendor.testnet", amount_near: 2 }, "INVALID_AMOUNT"],
      [{ receiver_id: "Vendor.testnet", amount_near: "1" }, "INVALID_RECEIVER"],
      [{ receiver_id: "a", amount_near: "1" }, "INVALID_RECEIVER"],
      [{ amount_near: "1" }, "INVALID_RECEIVER"],
      [{ receiver_id: "vendor.testnet", amount_near: "1", memo: 5 }, "INVALID_MEMO"],
    ];
    for (const [input, code] of bad) {
      await assert.rejects(guard.requestTransfer(input), (e: ToolError) => e.code === code, JSON.stringify(input));
    }
    assert.equal(sent.length, 0);
  });

  it("sends concurrent requests one at a time with increasing nonces", async () => {
    const { guard, sent } = chain();
    await Promise.all([
      guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "1" }),
      guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "2" }),
    ]);
    assert.deepEqual(
      sent.map((s) => s.nonce),
      [43n, 44n],
    );
  });

  it("still answers when the limits cannot be read", async () => {
    const { guard } = chain({ views: { get_window: () => { throw new Error("down"); } } });
    // A throwing view makes the fake RPC itself throw, like a network error on the view call.
    const r = await guard.requestTransfer({ receiver_id: "vendor.testnet", amount_near: "1" });
    assert.equal(r.status, "auto_approved");
    assert.deepEqual(r.limits, { max_per_tx: "unknown", max_per_day: "unknown", remaining_today: "unknown" });
  });
});

describe("guard_get_request_status", () => {
  it("refreshes a Pending request through sync_request and reports the council's answer", async () => {
    const pending = record({ decision: "Pending", reasons: ["NOT_WHITELISTED"], status: "Pending", proposal_id: 57 });
    const { guard, sent } = chain({ views: { get_request: () => pending }, onSend: () => success({ ...pending, status: "Rejected" }) });
    const r = await guard.getRequestStatus({ request_id: UUID });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.methodName, "sync_request");
    assert.deepEqual(sent[0]!.args, { request_id: UUID });
    assert.equal(r.status, "rejected");
    assert.equal(r.decision, "pending");
    assert.match(r.message, /council rejected/);
  });

  it("reads a final request without sending a transaction", async () => {
    const { guard, sent } = chain({ views: { get_request: () => record({ status: "Executed" }) } });
    const r = await guard.getRequestStatus({ request_id: UUID });
    assert.equal(sent.length, 0);
    assert.equal(r.status, "executed");
    assert.equal(r.amount_near, "2");
    assert.match(r.message, /Paid: 2 NEAR to vendor\.testnet/);
  });

  it("falls back to the last known status when the refresh fails", async () => {
    const { guard } = chain({ views: { get_request: () => record() }, onSend: () => new TypeError("fetch failed") });
    const r = await guard.getRequestStatus({ request_id: UUID });
    assert.equal(r.status, "auto_approved");
    assert.match(r.message, /Could not refresh/);
  });

  it("errors on an unknown or malformed request_id", async () => {
    const { guard } = chain();
    await assert.rejects(guard.getRequestStatus({ request_id: UUID }), (e: ToolError) => e.code === "NOT_FOUND");
    await assert.rejects(guard.getRequestStatus({ request_id: "short" }), (e: ToolError) => e.code === "INVALID_REQUEST_ID");
  });
});

describe("guard_get_policy", () => {
  it("returns limits in NEAR, the reset time, this agent and the whitelist", async () => {
    const { guard } = chain();
    const p = await guard.getPolicy();
    assert.equal(p.max_per_tx, "5");
    assert.equal(p.spent_today, "2.5");
    assert.equal(p.remaining_today, "7.5");
    assert.equal(p.resets_at, "2026-11-03T10:00:00.000Z");
    assert.deepEqual(p.agent, { account_id: AGENT, enabled: true, pending: 1 });
    assert.deepEqual(p.whitelist, [{ account_id: "vendor.testnet", label: "Vendor A", max_per_tx: null }]);
    assert.match(p.note, /Never split/);
  });
});

describe("tool definitions", () => {
  it("teach the agent that over-limit payments are the council's call", () => {
    const transfer = TOOLS.find((t) => t.name === "guard_request_transfer")!;
    assert.match(transfer.description, /never send the same payment again/);
    assert.match(transfer.description, /never split it/);
    assert.match(transfer.description, /council/);
    // The agent must not be able to choose the request_id or a raw yocto amount.
    assert.deepEqual(Object.keys(transfer.inputSchema.properties).sort(), ["amount_near", "memo", "receiver_id"]);
  });
});

describe("configFromEnv", () => {
  it("needs the Guard, the agent and the key path, and defaults to testnet", () => {
    const env = { GUARD_CONTRACT_ID: GUARD, AGENT_ACCOUNT_ID: AGENT, AGENT_KEY_PATH: "/k.json" };
    assert.equal(configFromEnv(env).rpcUrl, "https://rpc.testnet.fastnear.com");
    assert.equal(configFromEnv({ ...env, NEAR_RPC_URL: "https://x" }).rpcUrl, "https://x");
    assert.throws(() => configFromEnv({ ...env, AGENT_KEY_PATH: "" }), /AGENT_KEY_PATH is not set/);
    assert.throws(() => configFromEnv({ ...env, NEAR_NETWORK: "betanet" }), /NEAR_NETWORK/);
  });
});
