import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import { base58Decode as refDecode, base58Encode as refEncode, signTx } from "../../guard-mcp/src/near.ts";
import { base58Decode, base58Encode, guardEvents, loadKeeperKey, panicCode, signCall, type KeeperMethod } from "../src/keeper/near.ts";

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
