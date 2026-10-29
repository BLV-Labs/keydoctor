// GĐ10: network-wide numbers, one command. Run from the repo root:
//   pnpm stats -- [--network mainnet|testnet] [--block N] [--rpc URL] [--active-days 365] [--limit N]
// Every query is pinned to one block. Raw RPC answers are cached under data/raw/ (gitignored), so a rerun with
// the same --block reads the cache. An old --block needs an archival RPC (--rpc https://archival-rpc.mainnet.near.org).
// Writes data/network-stats.json and data/network-stats.md (aggregates only, no names).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isKdError, scanDao, type KdReport, type Network } from "../src/index.ts";
import { createRpc, DEFAULT_RPC_URL } from "../src/rpc.ts";
import { RULESET_VERSION } from "../src/rules/thresholds.ts";
import { aggregate, toMarkdown } from "./network-stats-lib.ts";

const FACTORY: Record<Network, string> = { mainnet: "sputnik-dao.near", testnet: "sputnik-v2.testnet" };

const { values } = parseArgs({
  options: {
    network: { type: "string", default: "mainnet" },
    block: { type: "string" },
    rpc: { type: "string" },
    "active-days": { type: "string", default: "365" },
    limit: { type: "string" },
    out: { type: "string", default: join(import.meta.dirname, "..", "..", "..", "data") },
  },
});
const network = values.network as Network;
if (network !== "mainnet" && network !== "testnet") throw new Error("--network must be mainnet or testnet");
const rpcUrl = values.rpc ?? DEFAULT_RPC_URL[network];
const activeDays = Number(values["active-days"]);
const outDir = values.out as string;
const cacheDir = join(outDir, "raw", "network-stats", network);
mkdirSync(cacheDir, { recursive: true });

// Cache pinned answers and retry rate limits, so a long run survives a public RPC.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const body = String(init?.body ?? "");
  const pinned = /"block_id":\d+/.test(body);
  const file = join(cacheDir, `${createHash("sha256").update(body).digest("hex")}.json`);
  if (pinned && existsSync(file)) return new Response(readFileSync(file, "utf8"), { status: 200 });
  for (let attempt = 0; ; attempt++) {
    const res = await realFetch(input, init);
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (pinned && res.ok) writeFileSync(file, text);
    return new Response(text, { status: res.status });
  }
};

async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

const rpc = createRpc({ url: rpcUrl });
let head: Awaited<ReturnType<typeof rpc.block>>;
let listed: string[];
try {
  head = await rpc.block(values.block === undefined ? undefined : Number(values.block));
  listed = (await rpc.callFunction(FACTORY[network], head.height, "get_dao_list", {})) as string[];
} catch (e) {
  console.error(isKdError(e) ? `${e.kd.code}: ${e.kd.message.en}` : "could not reach the RPC");
  process.exit(1);
}
const daos = values.limit === undefined ? listed : listed.slice(-Number(values.limit));
console.error(`block ${head.height}: ${listed.length} DAOs listed, checking ${daos.length}`);

const cutoffNs = BigInt(head.timestampMs - activeDays * 86_400_000) * 1_000_000n;
const active = (
  await pool(daos, 4, async (dao) => {
    try {
      const last = Number(await rpc.callFunction(dao, head.height, "get_last_proposal_id", {}));
      if (!(last > 0)) return null;
      const p = (await rpc.callFunction(dao, head.height, "get_proposal", { id: last - 1 })) as { submission_time?: string };
      return typeof p.submission_time === "string" && BigInt(p.submission_time) >= cutoffNs ? dao : null;
    } catch {
      return null;
    }
  })
).filter((d): d is string => d !== null);
console.error(`${active.length} active DAOs, scanning`);

let failed = 0;
let done = 0;
const reports = (
  await pool(active, 2, async (dao): Promise<KdReport | null> => {
    try {
      return await scanDao(dao, { network, rpcUrl, blockHeight: head.height, skipReceiverCheck: true });
    } catch (e) {
      failed += 1;
      if (!isKdError(e)) console.error("scan failed", e instanceof Error ? e.name : "unknown");
      return null;
    } finally {
      done += 1;
      if (done % 25 === 0) console.error(`${done}/${active.length}`);
    }
  })
).filter((r): r is KdReport => r !== null);

const stats = aggregate(reports, {
  network,
  block_height: head.height,
  block_timestamp: new Date(head.timestampMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
  ruleset_version: RULESET_VERSION,
  active_days: activeDays,
  daos_listed: listed.length,
  daos_active: active.length,
  daos_failed: failed,
});
writeFileSync(join(outDir, "network-stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
writeFileSync(join(outDir, "network-stats.md"), `${toMarkdown(stats)}\n`);
console.log(toMarkdown(stats));
