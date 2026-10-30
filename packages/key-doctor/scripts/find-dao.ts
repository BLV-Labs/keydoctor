// Find Sputnik DAOs with large councils, as benchmark targets. Run from the repo root:
//   pnpm find-dao [--network testnet|mainnet] [--limit 300] [--min 5] [--top 10]
// Lists the newest --limit DAOs of the network's Sputnik factory, reads each policy at one block, and prints the
// --top DAOs by council size (accounts in group roles, at most MAX_MEMBERS so a scan accepts them), with their
// proposal count. Prints to the terminal only and writes nothing: real mainnet names must never end up in the
// repo (examples, docs, fixtures). The bench output holds counts only, so a mainnet bench run can be committed.
import { parseArgs } from "node:util";
import { isKdError } from "../src/index.ts";
import { parsePolicy } from "../src/parse.ts";
import type { Network } from "../src/index.ts";
import { createRpc, DEFAULT_RPC_URLS } from "../src/rpc.ts";
import { MAX_MEMBERS } from "../src/rules/thresholds.ts";

const FACTORY: Record<Network, string> = { mainnet: "sputnik-dao.near", testnet: "sputnik-v2.testnet" };
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    network: { type: "string", default: "testnet" },
    limit: { type: "string", default: "300" },
    min: { type: "string", default: "5" },
    top: { type: "string", default: "10" },
  },
});
const network = values.network as Network;
if (network !== "mainnet" && network !== "testnet") throw new Error("--network must be mainnet or testnet");
const limit = Number(values.limit);
const min = Number(values.min);
const top = Number(values.top);

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

const rpc = createRpc({ url: DEFAULT_RPC_URLS[network] });
let height: number;
let listed: string[];
try {
  height = (await rpc.block()).height;
  listed = (await rpc.callFunction(FACTORY[network], height, "get_dao_list", {})) as string[];
} catch (e) {
  console.error(isKdError(e) ? `${e.kd.code}: ${e.kd.message.en}` : "could not reach the RPC");
  process.exit(1);
}
const daos = listed.slice(-limit);
console.error(`block ${height}: ${listed.length} DAOs listed, reading the newest ${daos.length} policies…`);

let done = 0;
const found = (
  await pool(daos, 4, async (dao) => {
    try {
      const policy = parsePolicy(await rpc.callFunction(dao, height, "get_policy", {}));
      if (policy === null) return null;
      const council = new Set(policy.roles.filter((r) => r.kind === "group").flatMap((r) => r.members));
      // Above MAX_MEMBERS a scan stops with LIMIT_EXCEEDED, so such a DAO is no use as a target.
      if (council.size < min || council.size > MAX_MEMBERS) return null;
      const proposals = Number(await rpc.callFunction(dao, height, "get_last_proposal_id", {}));
      return { dao, council: council.size, proposals: Number.isFinite(proposals) ? proposals : 0 };
    } catch {
      return null;
    } finally {
      done += 1;
      if (done % 50 === 0) console.error(`${done}/${daos.length}`);
    }
  })
).filter((d): d is { dao: string; council: number; proposals: number } => d !== null);

found.sort((a, b) => b.council - a.council || b.proposals - a.proposals);
if (found.length === 0) {
  console.log(`No DAO with at least ${min} council accounts among the newest ${daos.length}. Try --limit 2000 or --min 3.`);
} else {
  console.log("| DAO | Council accounts | Proposals |\n|---|---|---|");
  for (const d of found.slice(0, top)) console.log(`| ${d.dao} | ${d.council} | ${d.proposals} |`);
  const best = found[0] as { dao: string };
  const suffix = network === "mainnet" ? "near" : "testnet";
  console.log(`\nNext: pnpm bench --network ${network} --account <your-account>.${suffix} --dao ${best.dao} --runs 5`);
  if (network === "mainnet") console.log("Mainnet names: use them for the run only; never paste them into the repo.");
}
