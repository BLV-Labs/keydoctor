// NEAR RPC, the agent key file and transaction signing, with node:crypto and fetch only (no NEAR SDK).
// A transaction here is always one FunctionCall from the agent to the Guard: request_transfer or sync_request.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// PKCS#8 DER header for a raw 32-byte ed25519 seed.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function base58Encode(buf: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  const zeros = s.length - s.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

export interface AgentKey {
  accountId: string;
  publicKey: string; // "ed25519:<base58>"
  pub: Buffer;
  seed: Buffer;
}

function pubFromSeed(seed: Buffer): Buffer {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  return Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x!, "base64url");
}

/** Reads a near-cli key file ({account_id, public_key, private_key}) and checks it belongs to `accountId`. */
export function readAgentKey(path: string, accountId: string): AgentKey {
  const f = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (f.account_id !== accountId) throw new Error(`AGENT_KEY_PATH holds a key for ${String(f.account_id)}, not ${accountId}`);
  const sk = typeof f.private_key === "string" ? f.private_key : "";
  if (!sk.startsWith("ed25519:")) throw new Error("AGENT_KEY_PATH: private_key must be an ed25519 key");
  const raw = base58Decode(sk.slice(8));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("AGENT_KEY_PATH: private_key has the wrong length");
  const seed = raw.subarray(0, 32);
  const pub = pubFromSeed(seed);
  if (raw.length === 64 && !pub.equals(raw.subarray(32))) throw new Error("AGENT_KEY_PATH: private_key is corrupt");
  const publicKey = "ed25519:" + base58Encode(pub);
  if (f.public_key !== undefined && f.public_key !== publicKey) throw new Error("AGENT_KEY_PATH: public_key does not match private_key");
  return { accountId, publicKey, pub, seed };
}

// ---- borsh, only the shapes of one FunctionCall transaction (nearcore Transaction V0, Action::FunctionCall = 2).

class Writer {
  private parts: Buffer[] = [];
  u8(v: number) {
    this.parts.push(Buffer.from([v]));
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    this.parts.push(b);
  }
  u64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    this.parts.push(b);
  }
  u128(v: bigint) {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(v & 0xffffffffffffffffn);
    b.writeBigUInt64LE(v >> 64n, 8);
    this.parts.push(b);
  }
  raw(b: Uint8Array) {
    this.parts.push(Buffer.from(b));
  }
  bytes(b: Uint8Array) {
    this.u32(b.length);
    this.raw(b);
  }
  str(s: string) {
    this.bytes(Buffer.from(s, "utf8"));
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

export interface FunctionCallTx {
  signerId: string;
  pub: Buffer;
  nonce: bigint;
  receiverId: string;
  blockHash: Buffer;
  methodName: string;
  args: Buffer;
  gas: bigint;
  deposit: bigint;
}

export function serializeTx(t: FunctionCallTx): Buffer {
  const w = new Writer();
  w.str(t.signerId);
  w.u8(0); // ed25519
  w.raw(t.pub);
  w.u64(t.nonce);
  w.str(t.receiverId);
  w.raw(t.blockHash);
  w.u32(1);
  w.u8(2); // FunctionCall
  w.str(t.methodName);
  w.bytes(t.args);
  w.u64(t.gas);
  w.u128(t.deposit);
  return w.done();
}

/** Signed transaction bytes and the transaction hash (base58 of sha256 of the unsigned bytes). */
export function signTx(t: FunctionCallTx, seed: Buffer): { signed: Buffer; hash: string } {
  const body = serializeTx(t);
  const digest = createHash("sha256").update(body).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const sig = sign(null, digest, priv);
  return { signed: Buffer.concat([body, Buffer.from([0]), sig]), hash: base58Encode(digest) };
}

// ---- RPC

export class RpcError extends Error {
  readonly body: unknown;
  constructor(message: string, body: unknown) {
    super(message);
    this.body = body;
  }
}

export class Rpc {
  readonly url: string;
  private readonly fetchFn: typeof fetch;
  constructor(url: string, fetchFn: typeof fetch = fetch) {
    this.url = url;
    this.fetchFn = fetchFn;
  }

  async call(method: string, params: unknown): Promise<any> {
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "guard-mcp", method, params }),
    });
    const body = (await res.json()) as any;
    if (body.error) throw new RpcError(body.error.cause?.name ?? body.error.name ?? "RPC_ERROR", body.error);
    if (body.result?.error) throw new RpcError(String(body.result.error), body.result);
    return body.result;
  }

  async view<T>(contractId: string, methodName: string, args: unknown = {}): Promise<T> {
    const r = await this.call("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(r.result).toString()) as T;
  }

  /** The key's nonce and permission plus a recent block hash for the transaction. */
  async accessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; permission: unknown; blockHash: Buffer }> {
    const r = await this.call("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    return { nonce: BigInt(r.nonce), permission: r.permission, blockHash: base58Decode(r.block_hash) };
  }

  /** Waits until every receipt has run, so the outcome carries the Guard's final return value. */
  sendTx(signed: Buffer): Promise<any> {
    return this.call("send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "EXECUTED_OPTIMISTIC" });
  }
}

/** Contract panic code ("Smart contract panicked: PAUSED" -> "PAUSED"), or null. */
export function panicCode(failure: unknown): string | null {
  const m = /Smart contract panicked: ([A-Z_]+)/.exec(JSON.stringify(failure ?? null));
  return m ? m[1]! : null;
}
