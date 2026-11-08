// YD2 model step (yield plan §2, ADR 0004): one call to a TEE model on NEAR AI Cloud orders the report's suggestions
// and explains them. The model sees only code-built candidates, gets no tools, and its output passes validateAdvice;
// anything else falls back to the rule order, marked. Code owns every number and every proposal argument.
import {
  adviceCandidates,
  adviceFresh,
  adviceRequest,
  modelAdvice,
  ruleAdvice,
  validateAdvice,
  YIELD_ADVICE,
  YIELD_MODEL_CHAIN,
  YIELD_TEE_MODELS,
  type KdYieldAdvice,
  type KdYieldReport,
  type YieldAdviceFallback,
} from "key-doctor";
import type { Env } from "../env.ts";
import { getYieldAdvice, saveYieldAdvice } from "../store/yield.ts";

export const NEAR_AI_CHAT_URL = "https://cloud-api.near.ai/v1/chat/completions";
/** NEAR AI chat ids, kept for /v1/signature/{id}; anything else is not shown in a chat. */
const GENERATION_ID = /^[\w.:-]{1,128}$/;

type Log = (line: string) => void;

/**
 * Asks the TEE models in YIELD_MODEL_CHAIN, in order, until one answer passes validateAdvice. Never a model off the
 * TEE list, so a failure never falls through to a non-TEE model. Null when there is nothing to order. Logs only
 * model ids and short codes, never the key or the model text.
 */
export async function adviseYield(report: KdYieldReport, env: Env, log: Log = console.warn): Promise<KdYieldAdvice | null> {
  const candidates = adviceCandidates(report);
  if (candidates.length === 0) return null;
  const key = env.NEAR_AI_API_KEY;
  if (!key) return ruleAdvice(report, "NO_KEY");
  for (const id of YIELD_MODEL_CHAIN) {
    const model = YIELD_TEE_MODELS.find((m) => m.id === id);
    if (model === undefined) continue;
    try {
      const res = await fetch(NEAR_AI_CHAT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(adviceRequest(model, candidates)),
        signal: AbortSignal.timeout(YIELD_ADVICE.timeout_ms),
      });
      if (!res.ok) {
        log(`yield advice: ${model.id} HTTP_${res.status}`);
        continue;
      }
      const body = (await res.json()) as { id?: unknown; choices?: { message?: { content?: unknown } }[] };
      const items = validateAdvice(body.choices?.[0]?.message?.content, candidates);
      if (items === null) {
        log(`yield advice: ${model.id} INVALID_OUTPUT`);
        continue;
      }
      const generationId = typeof body.id === "string" && GENERATION_ID.test(body.id) ? body.id : null;
      return modelAdvice(report, model.id, generationId, items);
    } catch (e) {
      log(`yield advice: ${model.id} ${e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : "FAILED"}`);
    }
  }
  return ruleAdvice(report, "MODEL_FAILED");
}

/**
 * The advice to show with a report. Cached model advice that still fits the report is reused. Otherwise `gate`
 * says whether this caller may spend the key: null lets it call the model, a code returns the rule order marked
 * with that code. A model answer is cached; a fallback never is, so the next allowed caller tries again.
 */
export async function yieldAdvice(report: KdYieldReport, env: Env, gate: () => YieldAdviceFallback | null): Promise<KdYieldAdvice | null> {
  if (report.suggestions.length === 0) return null;
  // No key: the model step is off, and every surface behaves as before YD2 (no D1 read either).
  if (!env.NEAR_AI_API_KEY) return ruleAdvice(report, "NO_KEY");
  const cached = await getYieldAdvice(env.DB, report.dao, report.chain.network);
  if (cached !== null && adviceFresh(cached, report)) return cached;
  const denied = gate();
  if (denied !== null) return ruleAdvice(report, denied);
  const advice = await adviseYield(report, env);
  if (advice?.by === "model") await saveYieldAdvice(env.DB, advice);
  return advice;
}
