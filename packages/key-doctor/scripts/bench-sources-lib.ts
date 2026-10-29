// Pure helpers for bench-sources.ts: timing summaries and the Markdown table. Tested in test/bench-sources.test.ts.

export interface Sample {
  ms: number;
  /** HTTP status, or 0 when the request never got an answer (network error, timeout). */
  status: number;
  /** For a JSON-RPC call: true when the body had an `error` field even though HTTP said 200. */
  rpcError?: boolean;
}

export interface Summary {
  n: number;
  ok: number;
  /** Count of HTTP 429 answers. */
  limited: number;
  /** Count of other failures (status 0, non-2xx other than 429, or a JSON-RPC error). */
  failed: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

/** Nearest-rank percentile over the successful samples. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export function isOk(s: Sample): boolean {
  return s.status >= 200 && s.status < 300 && s.rpcError !== true;
}

export function summarize(samples: readonly Sample[]): Summary {
  const okMs = samples.filter(isOk).map((s) => s.ms).sort((a, b) => a - b);
  const limited = samples.filter((s) => s.status === 429).length;
  return {
    n: samples.length,
    ok: okMs.length,
    limited,
    failed: samples.length - okMs.length - limited,
    p50: percentile(okMs, 50),
    p95: percentile(okMs, 95),
    min: okMs[0] ?? null,
    max: okMs.at(-1) ?? null,
  };
}

export interface BurstResult {
  sent: number;
  ok: number;
  limited: number;
  /** 1-based index of the first 429, or null when none came back. */
  firstLimitedAt: number | null;
  wallMs: number;
  /** Rate-limit headers from the last answer, lower-cased names, values as sent. */
  headers: Record<string, string>;
}

/** Keeps only the headers that describe a rate limit; no other header (cookies, ids) leaves the script. */
export function rateLimitHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers) {
    const name = k.toLowerCase();
    if (/^(x-)?ratelimit|^retry-after$|^x-rate-limit/.test(name)) out[name] = v;
  }
  return out;
}

export function burstResult(samples: readonly (Sample & { headers?: Record<string, string> })[], wallMs: number): BurstResult {
  const idx = samples.findIndex((s) => s.status === 429);
  return {
    sent: samples.length,
    ok: samples.filter(isOk).length,
    limited: samples.filter((s) => s.status === 429).length,
    firstLimitedAt: idx === -1 ? null : idx + 1,
    wallMs,
    headers: samples.at(-1)?.headers ?? {},
  };
}

export interface SourceResult {
  /** Display name only (e.g. "rpc.testnet.near.org", "NearBlocks API"); never an API key. */
  source: string;
  kind: "rpc" | "nearblocks";
  calls: Record<string, Summary>;
  /** End-to-end library scan through this RPC (RPC sources only). */
  scan?: Summary & { members?: number };
  burst?: BurstResult;
}

export interface BenchResult {
  schema: "kd.bench_sources.v1";
  network: "mainnet" | "testnet";
  run_at: string;
  runs: number;
  /** Shapes, not names: mainnet names never go into the output. */
  account: { keys: number | null };
  dao: { members: number | null } | null;
  nearblocks_key: boolean;
  /** Field names of one NearBlocks key entry, to show what the indexer offers beyond RPC. */
  nearblocks_key_fields: string[] | null;
  sources: SourceResult[];
}

const ms = (v: number | null): string => (v === null ? "–" : `${Math.round(v)}`);

function row(source: string, call: string, s: Summary): string {
  const errs = [s.limited ? `${s.limited}× 429` : "", s.failed ? `${s.failed} failed` : ""].filter(Boolean).join(", ");
  return `| ${source} | ${call} | ${s.ok}/${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${s.min === null ? "–" : `${ms(s.min)}–${ms(s.max)}`} | ${errs || "–"} |`;
}

export function toMarkdown(r: BenchResult): string {
  const lines = [
    `### ${r.network} · ${r.run_at}`,
    "",
    `Runs per call: ${r.runs}. Account: ${r.account.keys ?? "?"} keys.` +
      (r.dao ? ` DAO: ${r.dao.members ?? "?"} council members.` : "") +
      ` NearBlocks API key: ${r.nearblocks_key ? "yes" : "no (free tier)"}.`,
    "",
    "| Source | Call | OK | p50 ms | p95 ms | min–max ms | Errors |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const s of r.sources) {
    for (const [call, sum] of Object.entries(s.calls)) lines.push(row(s.source, call, sum));
    if (s.scan) lines.push(row(s.source, `full scan${s.scan.members !== undefined ? ` (${s.scan.members} members)` : ""}`, s.scan));
  }
  const bursts = r.sources.filter((s) => s.burst);
  if (bursts.length > 0) {
    lines.push("", "| Source | Burst sent | OK | 429s | First 429 at | Wall ms | Rate-limit headers |", "|---|---|---|---|---|---|---|");
    for (const s of bursts) {
      const b = s.burst as BurstResult;
      const h = Object.entries(b.headers).map(([k, v]) => `\`${k}: ${v}\``).join(" ") || "none";
      lines.push(`| ${s.source} | ${b.sent} | ${b.ok} | ${b.limited} | ${b.firstLimitedAt ?? "–"} | ${Math.round(b.wallMs)} | ${h} |`);
    }
  }
  if (r.nearblocks_key_fields) lines.push("", `NearBlocks key entry fields: ${r.nearblocks_key_fields.map((f) => `\`${f}\``).join(", ")}.`);
  return lines.join("\n") + "\n";
}
