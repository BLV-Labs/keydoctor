import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { base58Decode, base58Encode, panicCode, readAgentKey, serializeTx, signTx } from "../src/near.ts";

const SEED = Buffer.alloc(32, 7);
// Reference bytes from @near-js/transactions 2.5.1 (encodeTransaction / SignedTransaction.encode) for this tx:
// agent.testnet -> guard.testnet, nonce 42, block hash 32 x 0x09, FunctionCall request_transfer {"a":1}, 200 Tgas, 0 deposit.
const REF_PUB = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const REF_TX =
  "0d0000006167656e742e746573746e657400ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c2a000000000000000d00000067756172642e746573746e65740909090909090909090909090909090909090909090909090909090909090909010000000210000000726571756573745f7472616e73666572070000007b2261223a317d0080f420e6b5000000000000000000000000000000000000";
const REF_SIG =
  "9803c58034cd9693531caa3a1b261e81e38b8b0832189af9d108b48a90178c27d6d9ff1110adbf26964580edf1453bf8e15721808da21678ed47295c4641da0e";

function keyFile(body: object): string {
  const p = join(mkdtempSync(join(tmpdir(), "guard-mcp-")), "key.json");
  writeFileSync(p, JSON.stringify(body));
  return p;
}

const pub = () => base58Decode(REF_PUB.slice(8));
const secret = () => "ed25519:" + base58Encode(Buffer.concat([SEED, pub()]));
const refTx = () => ({
  signerId: "agent.testnet",
  pub: pub(),
  nonce: 42n,
  receiverId: "guard.testnet",
  blockHash: Buffer.alloc(32, 9),
  methodName: "request_transfer",
  args: Buffer.from('{"a":1}'),
  gas: 200n * 10n ** 12n,
  deposit: 0n,
});

describe("base58", () => {
  it("round-trips, keeping leading zero bytes", () => {
    for (const hex of ["", "00", "0000ff", "ff", "0102030405060708090a"]) {
      const b = Buffer.from(hex, "hex");
      assert.deepEqual(base58Decode(base58Encode(b)), b, hex);
    }
    assert.throws(() => base58Decode("0OIl"), /base58/);
  });
});

describe("transaction encoding", () => {
  it("matches the NEAR SDK byte for byte, so nodes accept and hash it the same way", () => {
    assert.equal(serializeTx(refTx()).toString("hex"), REF_TX);
  });

  it("signs sha256 of the body and appends an ed25519 signature like the SDK", () => {
    const { signed, hash } = signTx(refTx(), SEED);
    assert.equal(signed.toString("hex"), REF_TX + "00" + REF_SIG);
    assert.equal(hash, base58Encode(createHash("sha256").update(Buffer.from(REF_TX, "hex")).digest()));
  });

  it("encodes a deposit as u128 little endian", () => {
    const t = serializeTx({ ...refTx(), deposit: 2n ** 64n + 1n });
    assert.equal(t.subarray(-16).toString("hex"), "01000000000000000100000000000000");
  });
});

describe("readAgentKey", () => {
  it("reads a near-cli key file and derives the public key from the seed", () => {
    const k = readAgentKey(keyFile({ account_id: "agent.testnet", public_key: REF_PUB, private_key: secret() }), "agent.testnet");
    assert.equal(k.publicKey, REF_PUB);
    const { signed } = signTx(refTx(), k.seed);
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), k.pub]);
    const digest = createHash("sha256").update(signed.subarray(0, -65)).digest();
    assert.ok(verify(null, digest, createPublicKey({ key: der, format: "der", type: "spki" }), signed.subarray(-64)));
  });

  it("refuses a key that belongs to another account, so the agent cannot sign as someone else", () => {
    const p = keyFile({ account_id: "other.testnet", public_key: REF_PUB, private_key: secret() });
    assert.throws(() => readAgentKey(p, "agent.testnet"), /other\.testnet, not agent\.testnet/);
  });

  it("refuses a file whose public and private keys disagree", () => {
    const wrongPub = "ed25519:" + base58Encode(Buffer.alloc(32, 1));
    assert.throws(() => readAgentKey(keyFile({ account_id: "agent.testnet", public_key: wrongPub, private_key: secret() }), "agent.testnet"), /does not match/);
    const corrupt = "ed25519:" + base58Encode(Buffer.concat([SEED, Buffer.alloc(32, 1)]));
    assert.throws(() => readAgentKey(keyFile({ account_id: "agent.testnet", private_key: corrupt }), "agent.testnet"), /corrupt/);
    assert.throws(() => readAgentKey(keyFile({ account_id: "agent.testnet", private_key: "secp256k1:abc" }), "agent.testnet"), /ed25519/);
  });
});

describe("panicCode", () => {
  it("pulls the contract error code out of a failure", () => {
    const f = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: TOO_MANY_PENDING" } } } };
    assert.equal(panicCode(f), "TOO_MANY_PENDING");
    assert.equal(panicCode({ ActionError: { kind: { AccountDoesNotExist: {} } } }), null);
  });
});
