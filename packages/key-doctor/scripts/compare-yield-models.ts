// Y5 live compare (yield plan §2, YD2): sends the same code-built candidates to every TEE model on YIELD_TEE_MODELS
// and checks each answer with validateAdvice, the same check the Worker runs. Settles which model goes first in
// YIELD_MODEL_CHAIN. Run from the repo root:
//   NEAR_AI_API_KEY=... pnpm yield-models [--runs 3] [--out data]
// The key comes from the environment only and is never printed or written. The candidates are synthetic testnet
// rows (realistic rates, fake holdings), so the output holds no real account. Writes data/yield-model-compare.json
// and .md; the .md keeps the first valid vi/en reasons of each variant so a person can judge the Vietnamese.
// The request body comes from adviceRequest, the same builder the Worker uses.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adviceCandidates, adviceRequest, validateAdvice, YIELD_ADVICE, YIELD_TEE_MODELS, type TeeModel, type YieldAdviceItem } from "../src/index.ts";
import { YIELD_SAMPLE_REPORT } from "./yield-sample.ts";

const CHAT_URL = "https://cloud-api.near.ai/v1/chat/completions";
/** Long enough to see how slow a model is; `in_worker_timeout` says whether the Worker would have waited. */
const SCRIPT_TIMEOUT_MS = 60_000;

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    out: { type: "string", default: join(import.meta.dirname, "..", "..", "..", "data") },
  },
});

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const key = process.env.NEAR_AI_API_KEY ?? "";
if (key === "") die("Set NEAR_AI_API_KEY in the environment (the Worker secret is not readable locally).");
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) die("--runs must be 1..10");

interface Variant {
  label: string;
  model: TeeModel;
}

const VARIANTS: Variant[] = YIELD_TEE_MODELS.flatMap((m) => {
  const base: Variant = { label: m.params ? `${m.id} (with ${JSON.stringify(m.params)})` : m.id, model: m };
  // Keep the run without the model's params, so a rerun still shows why they are there.
  return m.params ? [base, { label: `${m.id} (no params)`, model: { id: m.id, structured: m.structured } }] : [base];
});

interface Run {
  status: number | "TIMEOUT" | "FAILED";
  latency_ms: number;
  in_worker_timeout: boolean;
  valid: boolean;
  order: string[];
  reasons_kept: number;
  generation_id: string | null;
  completion_tokens: number | null;
  items: YieldAdviceItem[] | null;
}

const candidates = adviceCandidates(YIELD_SAMPLE_REPORT);
const NOW = YIELD_SAMPLE_REPORT.generated_at;

async function once(v: Variant): Promise<Run> {
  const started = performance.now();
  const fail = (status: Run["status"]): Run => {
    const latency_ms = Math.round(performance.now() - started);
    return { status, latency_ms, in_worker_timeout: latency_ms < YIELD_ADVICE.timeout_ms, valid: false, order: [], reasons_kept: 0, generation_id: null, completion_tokens: null, items: null };
  };
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(adviceRequest(v.model, candidates)),
      signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
    });
    if (!res.ok) return fail(res.status);
    const body = (await res.json()) as { id?: unknown; usage?: { completion_tokens?: unknown }; choices?: { message?: { content?: unknown } }[] };
    const latency_ms = Math.round(performance.now() - started);
    const items = validateAdvice(body.choices?.[0]?.message?.content, candidates);
    return {
      status: res.status,
      latency_ms,
      in_worker_timeout: latency_ms < YIELD_ADVICE.timeout_ms,
      valid: items !== null,
      order: items?.map((i) => i.opportunity_id) ?? [],
      reasons_kept: items?.filter((i) => i.reason !== null).length ?? 0,
      generation_id: typeof body.id === "string" ? body.id : null,
      completion_tokens: typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null,
      items,
    };
  } catch (e) {
    return fail(e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : "FAILED");
  }
}

const results: { variant: Variant; runs: Run[] }[] = [];
for (const v of VARIANTS) {
  const out: Run[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await once(v);
    console.error(`${v.label} #${i + 1}: ${r.status} ${r.latency_ms} ms valid=${r.valid} reasons=${r.reasons_kept}/${candidates.length}`);
    out.push(r);
  }
  results.push({ variant: v, runs: out });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)] as number);
};
const short = (id: string): string => id.replace(/^rhea-lend:/, "").replace(/:supply$/, "");

const lines: string[] = [
  "# Yield advice: TEE model compare (Y5)",
  "",
  `Run at ${NOW.replace(/\.\d{3}Z$/, "Z")}, ${runs} run(s) per variant, ${candidates.length} synthetic testnet candidates (rule order: ${candidates.map((c) => short(c.opportunity_id)).join(" > ")}).`,
  `Valid = the answer passed \`validateAdvice\`, the Worker's own check. Worker timeout: ${YIELD_ADVICE.timeout_ms} ms. Generated by \`packages/key-doctor/scripts/compare-yield-models.ts\`.`,
  "",
  "| Variant | Valid | Reasons kept | Within Worker timeout | p50 ms | Max ms | Statuses |",
  "|---|---|---|---|---|---|---|",
];
for (const { variant, runs: rs } of results) {
  const ok = rs.filter((r) => r.valid);
  lines.push(
    `| ${variant.label} | ${ok.length}/${rs.length} | ${ok.reduce((n, r) => n + r.reasons_kept, 0)}/${ok.length * candidates.length} | ${rs.filter((r) => r.in_worker_timeout && r.valid).length}/${rs.length} | ${median(rs.map((r) => r.latency_ms))} | ${Math.max(...rs.map((r) => r.latency_ms))} | ${[...new Set(rs.map((r) => r.status))].join(", ")} |`,
  );
}
lines.push("", "## First valid answer per variant", "");
for (const { variant, runs: rs } of results) {
  const first = rs.find((r) => r.valid);
  lines.push(`### ${variant.label}`, "");
  if (first === undefined || first.items === null) {
    lines.push("No valid answer.", "");
    continue;
  }
  lines.push(`Order: ${first.order.map(short).join(" > ")}. Generation id: \`${first.generation_id ?? "none"}\`.`, "");
  for (const it of first.items) {
    lines.push(`- **${short(it.opportunity_id)}**`);
    if (it.reason === null) lines.push("  - no reason (left out by the model, or dropped by the validator)");
    else lines.push(`  - vi: ${it.reason.vi}`, `  - en: ${it.reason.en}`);
  }
  lines.push("");
}

const outDir = values.out as string;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "yield-model-compare.json"), JSON.stringify({ run_at: NOW, runs, candidates, results }, null, 2) + "\n");
const md = lines.join("\n");
writeFileSync(join(outDir, "yield-model-compare.md"), md);
console.log(md);
