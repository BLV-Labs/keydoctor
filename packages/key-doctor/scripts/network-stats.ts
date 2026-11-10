// GĐ10: network-wide numbers, one command. Run from the repo root:
//   pnpm stats [--network mainnet|testnet] [--block N] [--rpc URL[,URL...]] [--active-days 365] [--limit N] [--all]
// --all scans every DAO the factory lists, not only the active ones, and writes network-stats-all.{json,md}.
// Every query is pinned to one block, so any node that answers gives the same answer. Each query tries the --rpc
// list in order until one gives a settled answer (see isSettled); only settled answers are cached under data/raw/
// (gitignored). If any query got no settled answer from any RPC, the run writes nothing and exits 1: rerun it, the
// cache keeps what was read. So a written file never depends on which RPC was slow that day.
// A --block older than about 60 hours needs an archival RPC in the list (archival-rpc.mainnet.near.org).
// Writes data/network-stats.json and data/network-stats.md (aggregates only, no names).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isKdError, scanDao, type KdReport, type Network } from "../src/index.ts";
import { createRpc, DEFAULT_RPC_URLS } from "../src/rpc.ts";
import { RPC_TIMEOUT_MS, RULESET_VERSION } from "../src/rules/thresholds.ts";
import { aggregate, isSettled, toMarkdown } from "./network-stats-lib.ts";

const FACTORY: Record<Network, string> = { mainnet: "sputnik-dao.near", testnet: "sputnik-v2.testnet" };
// Public mainnet RPCs that answered at a pinned block on 2026-11-10, fastest first; archival ones last.
const STATS_RPC_URLS: Record<Network, readonly string[]> = {
  mainnet: [
    "https://rpc.mainnet.fastnear.com",
    "https://free.rpc.fastnear.com",
    "https://near.drpc.org",
    "https://rpc.mainnet.near.org",
    "https://archival-rpc.mainnet.near.org",
    "https://archival-rpc.mainnet.fastnear.com",
  ],
  testnet: DEFAULT_RPC_URLS.testnet,
};
const ROUNDS = 3;

// pnpm forwards a literal "--"; drop it so both `pnpm stats --block N` and `pnpm stats -- --block N` work.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    network: { type: "string", default: "mainnet" },
    block: { type: "string" },
    rpc: { type: "string" },
    "active-days": { type: "string", default: "365" },
    limit: { type: "string" },
    all: { type: "boolean", default: false },
    out: { type: "string", default: join(import.meta.dirname, "..", "..", "..", "data") },
  },
});
const network = values.network as Network;
if (network !== "mainnet" && network !== "testnet") throw new Error("--network must be mainnet or testnet");
const rpcUrls = values.rpc === undefined ? STATS_RPC_URLS[network] : values.rpc.split(",").map((u) => u.trim());
const activeDays = Number(values["active-days"]);
const outDir = values.out as string;
const cacheDir = join(outDir, "raw", "network-stats", network);
mkdirSync(cacheDir, { recursive: true });

// This wrapper owns endpoint rotation: the library gets one URL and every request lands here, whatever its URL.
// A pinned query tries each RPC in turn, ROUNDS times with a growing pause, until one gives a settled answer.
let unsettled = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  const body = String(init?.body ?? "");
  const pinned = /"block_id":\d+/.test(body);
  const file = join(cacheDir, `${createHash("sha256").update(body).digest("hex")}.json`);
  if (pinned && existsSync(file)) return new Response(readFileSync(file, "utf8"), { status: 200 });
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** round));
    for (const url of rpcUrls) {
      let text: string;
      try {
        const res = await realFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        if (!res.ok) continue;
        text = await res.text();
      } catch {
        continue;
      }
      if (!pinned) return new Response(text, { status: 200 });
      if (isSettled(text)) {
        writeFileSync(file, text);
        return new Response(text, { status: 200 });
      }
    }
  }
  unsettled += 1;
  return new Response("", { status: 503 });
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

const rpc = createRpc({ url: rpcUrls[0] as string });
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
    } catch (e) {
      // NOT_A_DAO (no such method, a panic) is the chain's answer: not active. A node problem is counted in unsettled.
      if (!isKdError(e)) throw e;
      return null;
    }
  })
).filter((d): d is string => d !== null);
const targets = values.all ? daos : active;
console.error(`${active.length} active DAOs, scanning ${targets.length}`);

const failedByCode: Record<string, number> = {};
let failed = 0;
let done = 0;
const reports = (
  await pool(targets, 2, async (dao): Promise<KdReport | null> => {
    try {
      return await scanDao(dao, { network, rpcUrl: rpcUrls[0] as string, blockHeight: head.height, skipReceiverCheck: true });
    } catch (e) {
      if (!isKdError(e)) throw e;
      failed += 1;
      failedByCode[e.kd.code] = (failedByCode[e.kd.code] ?? 0) + 1;
      return null;
    } finally {
      done += 1;
      if (done % 25 === 0) console.error(`${done}/${targets.length}`);
    }
  })
).filter((r): r is KdReport => r !== null);

if (unsettled > 0) {
  console.error(`${unsettled} queries got no settled answer from any RPC. Nothing written; rerun (the cache keeps the rest).`);
  process.exit(1);
}

const stats = aggregate(reports, {
  network,
  scope: values.all ? "all" : "active",
  block_height: head.height,
  block_timestamp: new Date(head.timestampMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
  ruleset_version: RULESET_VERSION,
  active_days: activeDays,
  daos_listed: listed.length,
  daos_active: active.length,
  daos_failed: failed,
  daos_failed_by_code: failedByCode,
});
const base = values.all ? "network-stats-all" : "network-stats";
writeFileSync(join(outDir, `${base}.json`), `${JSON.stringify(stats, null, 2)}\n`);
writeFileSync(join(outDir, `${base}.md`), `${toMarkdown(stats)}\n`);
console.log(toMarkdown(stats));
