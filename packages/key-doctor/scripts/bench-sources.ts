// Benchmark the data sources a scan can read from: NEAR JSON-RPC endpoints and the NearBlocks indexer API.
// Run from the repo root:
//   pnpm bench --account <id> [--dao <id>] [--network testnet|mainnet] [--runs 5] [--rpc URL]... [--burst 0]
//   NEARBLOCKS_API_KEY=... pnpm bench ...   (optional; without it the free tier's 6 calls/minute applies)
// Measures per-call latency (p50/p95), one full library scan per RPC, and, with --burst N, how many back-to-back
// calls each source takes before it answers 429. Writes data/bench-sources-<network>.json and .md.
// The output holds shapes only (key and member counts), never account names, so a mainnet run can be published.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isKdError, resolveTarget, scanTarget, type Network } from "../src/index.ts";
import {
  burstResult,
  rateLimitHeaders,
  summarize,
  toMarkdown,
  type BenchResult,
  type Sample,
  type SourceResult,
} from "./bench-sources-lib.ts";

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    account: { type: "string" },
    dao: { type: "string" },
    network: { type: "string" },
    runs: { type: "string", default: "5" },
    rpc: { type: "string", multiple: true },
    burst: { type: "string", default: "0" },
    "gap-ms": { type: "string", default: "300" },
    "nb-gap-ms": { type: "string" },
    "skip-nearblocks": { type: "boolean", default: false },
    out: { type: "string", default: join(import.meta.dirname, "..", "..", "..", "data") },
  },
});

function die(message: string): never {
  console.error(message);
  process.exit(2);
}

if (values.account === undefined) die("usage: bench-sources.ts --account <id> [--dao <id>] [--network testnet|mainnet] [--runs 5] [--rpc URL]... [--burst N]");
if (values.network !== undefined && values.network !== "mainnet" && values.network !== "testnet") die("--network must be mainnet or testnet");
const account = resolveTarget(values.account, { network: values.network as Network | undefined });
const network = account.network;
const dao = values.dao === undefined ? null : resolveTarget(values.dao, { network });
const runs = Number(values.runs);
const burst = Number(values.burst);
const gapMs = Number(values["gap-ms"]);
const nbKey = process.env.NEARBLOCKS_API_KEY?.trim() || null;
// Free tier: 6 calls per minute, so one call every 10 s plus a margin.
const nbGapMs = values["nb-gap-ms"] !== undefined ? Number(values["nb-gap-ms"]) : nbKey ? 400 : 10_500;

const DEFAULT_RPCS: Record<Network, string[]> = {
  mainnet: ["https://rpc.mainnet.near.org", "https://rpc.mainnet.fastnear.com"],
  testnet: ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"],
};
const NEARBLOCKS: Record<Network, string> = { mainnet: "https://api.nearblocks.io", testnet: "https://api-testnet.nearblocks.io" };
const rpcs = values.rpc ?? DEFAULT_RPCS[network];
const TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Host only: a provider URL can carry an API key in its path or query. */
const display = (url: string) => new URL(url).host;

async function timed(url: string, init: RequestInit): Promise<Sample & { body: unknown; headers: Record<string, string> }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    const ms = performance.now() - t0;
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON answer (an HTML error page): the status already tells the story.
    }
    const rpcError = typeof body === "object" && body !== null && "error" in body && (body as { error: unknown }).error != null;
    return { ms, status: res.status, rpcError, body, headers: rateLimitHeaders(res.headers) };
  } catch {
    return { ms: performance.now() - t0, status: 0, body: null, headers: {} };
  }
}

const rpcCall = (url: string, method: string, params: unknown) =>
  timed(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "kd-bench", method, params }),
  });

const nbCall = (path: string) =>
  timed(NEARBLOCKS[network] + path, { headers: { accept: "application/json", ...(nbKey ? { authorization: `Bearer ${nbKey}` } : {}) } });

async function repeat(n: number, gap: number, fn: () => Promise<Sample>): Promise<Sample[]> {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await fn());
    if (i < n - 1) await sleep(gap);
  }
  return out;
}

async function burstProbe(n: number, fn: () => Promise<Sample & { headers: Record<string, string> }>) {
  const t0 = performance.now();
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(await fn());
  return burstResult(samples, performance.now() - t0);
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
let accountKeys: number | null = null;
let daoMembers: number | null = null;

async function benchRpc(url: string): Promise<SourceResult> {
  const name = display(url);
  console.error(`· ${name}`);
  const head = await rpcCall(url, "block", { finality: "final" });
  const height = (head.body as { result?: { header?: { height?: number } } } | null)?.result?.header?.height;
  if (typeof height !== "number") return { source: name, kind: "rpc", calls: { block: summarize([head]) } };

  const calls: SourceResult["calls"] = {};
  calls["block (final)"] = summarize(await repeat(runs, gapMs, () => rpcCall(url, "block", { finality: "final" })));
  const keyList = await repeat(runs, gapMs, async () => {
    const s = await rpcCall(url, "query", { request_type: "view_access_key_list", account_id: account.id, block_id: height });
    const keys = (s.body as { result?: { keys?: unknown[] } } | null)?.result?.keys;
    if (Array.isArray(keys)) accountKeys = keys.length;
    return s;
  });
  calls["view_access_key_list"] = summarize(keyList);
  calls["view_account"] = summarize(
    await repeat(runs, gapMs, () => rpcCall(url, "query", { request_type: "view_account", account_id: account.id, block_id: height })),
  );
  if (dao) {
    calls["call_function get_policy"] = summarize(
      await repeat(runs, gapMs, () =>
        rpcCall(url, "query", { request_type: "call_function", account_id: dao.id, method_name: "get_policy", args_base64: b64({}), block_id: height }),
      ),
    );
    calls["call_function get_last_proposal_id"] = summarize(
      await repeat(runs, gapMs, () =>
        rpcCall(url, "query", { request_type: "call_function", account_id: dao.id, method_name: "get_last_proposal_id", args_base64: b64({}), block_id: height }),
      ),
    );
  }

  // End to end: the same library call the dashboard and the bot make, through this RPC.
  const scanSamples: Sample[] = [];
  let members: number | undefined;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    try {
      const report = await scanTarget(dao?.id ?? account.id, { rpcUrl: url, network });
      members = report.members.length;
      scanSamples.push({ ms: performance.now() - t0, status: 200 });
    } catch (e) {
      scanSamples.push({ ms: performance.now() - t0, status: isKdError(e) && e.kd.code === "RATE_LIMITED" ? 429 : 0 });
    }
    await sleep(gapMs);
  }
  if (dao && members !== undefined) daoMembers = members;
  const result: SourceResult = { source: name, kind: "rpc", calls, scan: { ...summarize(scanSamples), members } };
  if (burst > 0) result.burst = await burstProbe(burst, () => rpcCall(url, "block", { finality: "final" }));
  return result;
}

let nbKeyFields: string[] | null = null;

async function benchNearBlocks(): Promise<SourceResult> {
  const name = `NearBlocks API (${new URL(NEARBLOCKS[network]).host})`;
  console.error(`· ${name}, ${Math.round(nbGapMs / 1000)} s between calls`);
  const calls: SourceResult["calls"] = {};
  calls["GET /v1/account/{id}"] = summarize(await repeat(runs, nbGapMs, () => nbCall(`/v1/account/${account.id}`)));
  await sleep(nbGapMs);
  calls["GET /v1/account/{id}/keys"] = summarize(
    await repeat(runs, nbGapMs, async () => {
      const s = await nbCall(`/v1/account/${account.id}/keys`);
      const body = s.body as Record<string, unknown> | null;
      const list = body && Object.values(body).find(Array.isArray);
      const first = Array.isArray(list) ? list[0] : undefined;
      if (first && typeof first === "object") nbKeyFields = Object.keys(first as object).sort();
      return s;
    }),
  );
  const result: SourceResult = { source: name, kind: "nearblocks", calls };
  if (burst > 0) {
    await sleep(nbGapMs);
    result.burst = await burstProbe(burst, () => nbCall(`/v1/account/${account.id}`));
  }
  return result;
}

const sources: SourceResult[] = [];
for (const url of rpcs) sources.push(await benchRpc(url));
if (!values["skip-nearblocks"]) sources.push(await benchNearBlocks());

const result: BenchResult = {
  schema: "kd.bench_sources.v1",
  network,
  run_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  runs,
  account: { keys: accountKeys },
  dao: dao ? { members: daoMembers } : null,
  nearblocks_key: nbKey !== null,
  nearblocks_key_fields: nbKeyFields,
  sources,
};

const outDir = values.out as string;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `bench-sources-${network}.json`), JSON.stringify(result, null, 2) + "\n");
const md = toMarkdown(result);
writeFileSync(join(outDir, `bench-sources-${network}.md`), md);
console.log(md);
