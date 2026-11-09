import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import { base58Decode as refDecode, base58Encode as refEncode, signTx } from "../../guard-mcp/src/near.ts";
import { base58Decode, base58Encode, guardEvents, loadKeeperKey, panicCode, signCall, swapOutcome, type KeeperMethod, type TxOutcome } from "../src/keeper/near.ts";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
// RFC 8032 style fixed key material: test value only, never funded.
const KEEPER = "keeper.kd-demo.testnet";
const GUARD = "payroll.keydoctor-guards-v2.testnet";
const BLOCK = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

async function testKey(bytes: 32 | 64 = 64) {
  const seedOnly = await loadKeeperKey(KEEPER, `ed25519:${base58Encode(SEED)}`);
  if (bytes === 32) return { k: seedOnly, secret: `ed25519:${base58Encode(SEED)}` };
  const secret = `ed25519:${base58Encode(Uint8Array.from([...SEED, ...seedOnly.pub]))}`;
  return { k: await loadKeeperKey(KEEPER, secret), secret };
}

describe("keeper signing", () => {
  it("base58 agrees with the Guard MCP, leading zero bytes included", () => {
    for (const b of [new Uint8Array(0), Uint8Array.of(0, 0, 1), BLOCK, SEED]) {
      assert.equal(base58Encode(b), refEncode(b));
      assert.deepEqual([...base58Decode(refEncode(b))], [...refDecode(refEncode(b))]);
    }
  });

  it("produces the exact bytes of the Guard MCP signer, which runs against live testnet, with the fixed gas and no deposit", async () => {
    const { k } = await testKey();
    const mine = await signCall(k, 42n, BLOCK, GUARD, "execute_plan_step", { plan_id: 3 });
    const ref = signTx(
      {
        signerId: KEEPER,
        pub: Buffer.from(k.pub),
        nonce: 42n,
        receiverId: GUARD,
        blockHash: Buffer.from(BLOCK),
        methodName: "execute_plan_step",
        args: Buffer.from(JSON.stringify({ plan_id: 3 })),
        gas: 300_000_000_000_000n,
        deposit: 0n,
      },
      Buffer.from(SEED),
    );
    assert.equal(Buffer.from(mine.signed).toString("hex"), ref.signed.toString("hex"));
    assert.equal(mine.hash, ref.hash);
  });

  it("signs a signature a node would accept for this key", async () => {
    const { k } = await testKey();
    const { signed } = await signCall(k, 1n, BLOCK, GUARD, "sync_request", { request_id: "plan-0-1" });
    const body = signed.subarray(0, signed.length - 65);
    const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(k.pub)]);
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    assert.equal(verify(null, Buffer.from(digest), pub, Buffer.from(signed.subarray(signed.length - 64))), true);
  });

  it("refuses any method outside ADR 0005: the Worker's key must not become a general signer", async () => {
    const { k } = await testKey();
    await assert.rejects(signCall(k, 1n, BLOCK, GUARD, "add_proposal" as KeeperMethod, {}), /only execute_plan_step and sync_request/);
  });

  it("accepts a 32-byte seed and derives the same public key", async () => {
    assert.equal((await testKey(32)).k.publicKey, (await testKey(64)).k.publicKey);
  });

  it("rejects a bad secret without repeating any of it (K5)", async () => {
    const { secret } = await testKey();
    const flipped = `${secret.slice(0, -2)}${secret.endsWith("11") ? "22" : "11"}`;
    const bad = ["secp256k1:abc", "ed25519:0OIl", "ed25519:abc", flipped];
    for (const value of bad) {
      await assert.rejects(loadKeeperKey(KEEPER, value), (e: Error) => {
        assert.match(e.message, /^KEEPER_PRIVATE_KEY/);
        assert.equal(e.message.includes(value.slice(8)), false);
        return true;
      });
    }
  });
});

describe("keeper outcome parsing", () => {
  it("keeps only kd_guard events and survives other logs", () => {
    const log = (o: unknown) => `EVENT_JSON:${JSON.stringify(o)}`;
    const events = guardEvents({
      status: {},
      receipts_outcome: [
        { outcome: { logs: ["hello", "EVENT_JSON:{broken", log({ standard: "nep141", event: "ft_transfer", data: [{}] })] } },
        { outcome: { logs: [log({ standard: "kd_guard", version: "1.0.0", event: "plan_step_executed", data: [{ plan_id: 1, run: 2 }] })] } },
      ],
    });
    assert.deepEqual(events, [{ event: "plan_step_executed", data: { plan_id: 1, run: 2 } }]);
  });

  it("reads a panic code", () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: PLAN_NOT_DUE" } } } };
    assert.equal(panicCode(failure), "PLAN_NOT_DUE");
    assert.equal(panicCode(undefined), null);
  });
});

describe("GD31 swapOutcome: the exchange's own receipt decides", () => {
  const EX = "ref-finance-101.testnet";
  const WRAP = "wrap.testnet";
  const OUT = "usdt.fakes.testnet";
  // The real Rhea log shape.
  const SWAPPED = `Swapped 100000000000000000000000 ${WRAP} for 896500 ${OUT}`;
  const tx = (...r: { executor_id?: string; logs?: string[]; failure?: unknown }[]): TxOutcome => ({
    status: {},
    receipts_outcome: r.map((x) => ({ outcome: { logs: x.logs ?? [], executor_id: x.executor_id, ...(x.failure !== undefined && { status: { Failure: x.failure } }) } })),
  });
  const run = (t: TxOutcome) => swapOutcome(t, EX, WRAP, OUT);

  it("reads amount_out from the Swapped log of the exchange receipt", () => {
    assert.deepEqual(run(tx({ executor_id: "g.testnet" }, { executor_id: EX, logs: ["noise", SWAPPED] })), { amount_out: "896500" });
  });

  it("ignores the same log from any other executor: a contract in the chain could forge it (the Budget would show money it never got)", () => {
    assert.equal(run(tx({ executor_id: "evil.testnet", logs: [SWAPPED] })), null);
    assert.equal(run(tx({ executor_id: OUT, logs: [SWAPPED] })), null);
    assert.equal(run(tx({ logs: [SWAPPED] })), null, "no executor_id is not the exchange either");
    // A forged line first must not shadow the real one.
    assert.deepEqual(run(tx({ executor_id: "evil.testnet", logs: [`Swapped 1 ${WRAP} for 999999999 ${OUT}`] }, { executor_id: EX, logs: [SWAPPED] })), { amount_out: "896500" });
  });

  it("only the exact shape counts: another token pair or trailing text is not our swap", () => {
    for (const l of [`Swapped 1 ${WRAP} for 5 other.testnet`, `Swapped 1 other.testnet for 5 ${OUT}`, `${SWAPPED} extra`, `Swapped 1 ${WRAP} for x ${OUT}`, `Swapped 1 wrapXtestnet for 5 ${OUT}`]) {
      assert.equal(run(tx({ executor_id: EX, logs: [l] })), null, l);
    }
  });

  it("an exchange failure with E68 is SLIPPAGE: the price moved, the user can read why", () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: E68: slippage error" } } } };
    assert.deepEqual(run(tx({ executor_id: EX, failure })), { failed: "SLIPPAGE" });
  });

  it("any other exchange failure is SWAP_FAILED", () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: E21: token not registered" } } } };
    assert.deepEqual(run(tx({ executor_id: EX, failure })), { failed: "SWAP_FAILED" });
  });

  it("a failure of another contract's receipt is not the exchange refusing", () => {
    assert.equal(run(tx({ executor_id: "g.testnet", failure: "E68" })), null);
  });

  it("no exchange receipt (send_tx returned early) is null, so the step is recorded without a number", () => {
    assert.equal(run(tx({ executor_id: "g.testnet", logs: [] })), null);
    assert.equal(run(tx()), null);
  });
});
