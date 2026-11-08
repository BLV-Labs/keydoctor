// NEAR signing and RPC for the keeper (ADR 0005), with WebCrypto and fetch only: a Worker has no Buffer and we use no
// NEAR SDK. Same wire format as apps/guard-mcp/src/near.ts; test/keeper-near.test.ts holds the two byte for byte.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// PKCS#8 DER header for a raw 32-byte ed25519 seed.
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const TGAS = 10n ** 12n;

/**
 * The only two calls the keeper signs. K2a: both are caller-blind and take no deposit, and gas is fixed here.
 * 200 Tgas is what the sandbox runs a step with (145 is the lowest that works); 50 covers the DAO view and callback.
 */
const KEEPER_GAS = { execute_plan_step: 200n * TGAS, sync_request: 50n * TGAS } as const;
export type KeeperMethod = keyof typeof KEEPER_GAS;

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  const zeros = s.length - s.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...out]);
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromBase64Url = (s: string): Uint8Array => fromBase64(s.replaceAll("-", "+").replaceAll("_", "/"));

export interface KeeperKey {
  accountId: string;
  /** "ed25519:<base58>" */
  publicKey: string;
  pub: Uint8Array;
  key: CryptoKey;
}

/** Reads KEEPER_PRIVATE_KEY ("ed25519:<base58>", 64 or 32 bytes). No message here may carry any of the value (K5). */
export async function loadKeeperKey(accountId: string, secret: string): Promise<KeeperKey> {
  if (!secret.startsWith("ed25519:")) throw new Error("KEEPER_PRIVATE_KEY must be an ed25519 key");
  let raw: Uint8Array;
  try {
    raw = base58Decode(secret.slice("ed25519:".length));
  } catch {
    throw new Error("KEEPER_PRIVATE_KEY is not base58");
  }
  if (raw.length !== 64 && raw.length !== 32) throw new Error("KEEPER_PRIVATE_KEY has the wrong length");
  const key = await crypto.subtle.importKey("pkcs8", concat(PKCS8_ED25519, raw.subarray(0, 32)) as BufferSource, "Ed25519", true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const pub = fromBase64Url(String(jwk.x));
  if (raw.length === 64 && base58Encode(raw.subarray(32)) !== base58Encode(pub)) throw new Error("KEEPER_PRIVATE_KEY is corrupt");
  return { accountId, publicKey: `ed25519:${base58Encode(pub)}`, pub, key };
}

// ---- borsh, only the shapes of one FunctionCall transaction (nearcore Transaction V0, Action::FunctionCall = 2).

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const u32 = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const u64 = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const sized = (b: Uint8Array): Uint8Array => concat(u32(b.length), b);
const str = (s: string): Uint8Array => sized(utf8(s));

/** Signed transaction bytes and its hash. The hash is known before sending, so a timeout does not lose it. */
export async function signCall(
  k: KeeperKey,
  nonce: bigint,
  blockHash: Uint8Array,
  receiverId: string,
  method: KeeperMethod,
  args: unknown,
): Promise<{ signed: Uint8Array; hash: string }> {
  const gas = KEEPER_GAS[method];
  if (gas === undefined) throw new Error("the keeper signs only execute_plan_step and sync_request");
  const body = concat(
    str(k.accountId),
    Uint8Array.of(0), // ed25519
    k.pub,
    u64(nonce),
    str(receiverId),
    blockHash,
    u32(1),
    Uint8Array.of(2), // FunctionCall
    str(method),
    sized(utf8(JSON.stringify(args))),
    u64(gas),
    new Uint8Array(16), // deposit: always zero (K2a)
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", k.key, digest as BufferSource));
  return { signed: concat(body, Uint8Array.of(0), signature), hash: base58Encode(digest) };
}

// ---- RPC

export class RpcFailed extends Error {}

/** One outcome of `send_tx`: enough of nearcore's FinalExecutionOutcomeView for the keeper. */
export interface TxOutcome {
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome: { outcome: { logs: string[] } }[];
}

/** `kd_guard` NEP-297 events of a transaction, in order. */
export function guardEvents(tx: TxOutcome): { event: string; data: any }[] {
  const events: { event: string; data: any }[] = [];
  for (const r of tx.receipts_outcome) {
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: unknown[] };
        if (e.standard === "kd_guard" && typeof e.event === "string") events.push({ event: e.event, data: e.data?.[0] });
      } catch {
        // Not ours: any contract in the chain can log.
      }
    }
  }
  return events;
}

/** Contract panic code ("Smart contract panicked: PAUSED" -> "PAUSED"), or null. */
export function panicCode(failure: unknown): string | null {
  return /Smart contract panicked: ([A-Z_]+)/.exec(JSON.stringify(failure ?? null))?.[1] ?? null;
}

export function createKeeperRpc(urls: readonly string[]) {
  /** Next URL on a transport failure. Sending the same signed bytes twice is safe: one nonce runs once. */
  async function call(method: string, params: unknown): Promise<any> {
    let failure = "RPC_UNAVAILABLE";
    for (const url of urls) {
      let body: { error?: { cause?: { name?: string }; name?: string }; result?: any };
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "kd-keeper", method, params }),
        });
        if (!res.ok) {
          failure = `RPC_HTTP_${res.status}`;
          continue;
        }
        body = (await res.json()) as typeof body;
      } catch {
        continue;
      }
      if (body.error) throw new RpcFailed(body.error.cause?.name ?? body.error.name ?? "RPC_ERROR");
      if (body.result?.error) throw new RpcFailed("CONTRACT_ERROR");
      return body.result;
    }
    throw new RpcFailed(failure);
  }

  return {
    /** Final head: its time decides what is due, so a step never goes early; its hash anchors transactions. */
    async head(): Promise<{ hash: Uint8Array; timestampNs: bigint }> {
      const r = await call("block", { finality: "final" });
      return { hash: base58Decode(r.header.hash), timestampNs: BigInt(r.header.timestamp_nanosec) };
    },
    /** Liquid balance in yoctoNEAR. */
    async balance(accountId: string): Promise<bigint> {
      const r = await call("query", { request_type: "view_account", finality: "final", account_id: accountId });
      return BigInt(r.amount);
    },
    async nonce(accountId: string, publicKey: string): Promise<bigint> {
      const r = await call("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
      return BigInt(r.nonce);
    },
    async view<T>(contractId: string, methodName: string, args: unknown = {}): Promise<T> {
      const r = await call("query", {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: methodName,
        args_base64: toBase64(utf8(JSON.stringify(args))),
      });
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result as number[]))) as T;
    },
    /** Waits until every receipt has run, so the outcome carries the Guard's events. */
    sendTx(signed: Uint8Array): Promise<TxOutcome> {
      return call("send_tx", { signed_tx_base64: toBase64(signed), wait_until: "EXECUTED_OPTIMISTIC" });
    },
  };
}

export type KeeperRpc = ReturnType<typeof createKeeperRpc>;
