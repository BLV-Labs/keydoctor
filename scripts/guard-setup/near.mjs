#!/usr/bin/env node
// Read-only testnet RPC, agent key generation and yoctoNEAR math for setup.sh. No dependencies, signs nothing.
//
//   near.mjs view <account> <method> <json-args>   view call result (JSON)
//   near.mjs account <account>                      {"exists","code","amount","spendable"} (yoctoNEAR strings)
//   near.mjs keys <account>                         view_access_key_list keys (JSON array)
//   near.mjs keygen <file> <account>                new ed25519 key in near-cli JSON, mode 600; prints the public key
//   near.mjs yocto <near> | fmt <yocto>             exact decimal NEAR <-> yoctoNEAR
//   near.mjs add|sub <a> <b> | ge <a> <b>           yoctoNEAR math; ge exits 1 when a < b
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RPC = process.env.RPC_URL_TESTNET || "https://rpc.testnet.near.org";
const STORAGE_BYTE_COST = 10n ** 19n; // yoctoNEAR per byte (NEAR protocol config)
const YOCTO = 10n ** 24n;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
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

export function yocto(near) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(near);
  if (!m) throw new Error(`not a NEAR amount: ${near}`);
  return (BigInt(m[1]) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0"))).toString();
}

export function fmt(y) {
  const v = BigInt(y);
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return `${v / YOCTO}${frac ? "." + frac : ""} NEAR`;
}

export async function query(params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }),
  });
  const body = await res.json();
  const err = body.error ?? (body.result?.error ? { message: body.result.error } : null);
  if (err) {
    const e = new Error(JSON.stringify(err));
    e.unknownAccount = err.cause?.name === "UNKNOWN_ACCOUNT" || /does not exist/.test(err.message ?? "");
    throw e;
  }
  return body.result;
}

export async function account(id) {
  try {
    const a = await query({ request_type: "view_account", account_id: id });
    const spendable = BigInt(a.amount) - BigInt(a.storage_usage) * STORAGE_BYTE_COST;
    return { exists: true, code: a.code_hash !== "11111111111111111111111111111111", amount: a.amount, spendable: spendable.toString() };
  } catch (e) {
    if (e.unknownAccount) return { exists: false, code: false, amount: "0", spendable: "0" };
    throw e;
  }
}

function keygen(file, accountId) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const public_key = "ed25519:" + base58(pub);
  const private_key = "ed25519:" + base58(Buffer.concat([seed, pub]));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // "wx": never overwrite an existing key file.
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key, private_key }) + "\n", { mode: 0o600, flag: "wx" });
  return public_key;
}

async function main([cmd, a, b, c]) {
  switch (cmd) {
    case "view": {
      const r = await query({ request_type: "call_function", account_id: a, method_name: b, args_base64: Buffer.from(c ?? "{}").toString("base64") });
      return Buffer.from(r.result).toString();
    }
    case "account":
      return JSON.stringify(await account(a));
    case "keys":
      return JSON.stringify((await query({ request_type: "view_access_key_list", account_id: a })).keys);
    case "keygen":
      return keygen(a, b);
    case "yocto":
      return yocto(a);
    case "fmt":
      return fmt(a);
    case "add":
      return (BigInt(a) + BigInt(b)).toString();
    case "sub":
      return (BigInt(a) - BigInt(b)).toString();
    case "ge":
      if (BigInt(a) < BigInt(b)) process.exit(1);
      return "";
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (out) => out && console.log(out),
    (e) => {
      console.error(e.message);
      process.exit(2);
    },
  );
}
