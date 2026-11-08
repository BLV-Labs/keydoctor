// Plan §2 and Y5: only models on this list may be called, and a failure never falls through to a model off it.
// Every id is a Private TEE model on NEAR AI Cloud, checked against /v1/models on 2026-11-08. Look-alike ids from
// other providers (for example `deepseek/...`, owned_by deepseek) are not TEE models and must never be added.

export interface TeeModel {
  id: string;
  /** /v1/models lists `structured_outputs`: the call can send a JSON schema. Without it, code parses free text. */
  structured: boolean;
  /** Extra request fields this model needs. Never `tools`, `tool_choice` or `functions` (plan §2). */
  params?: Readonly<Record<string, unknown>>;
}

export const YIELD_TEE_MODELS: readonly TeeModel[] = [
  // Thinking on spent all 1,200 tokens on reasoning and returned no answer in 3/3 runs (Y5 compare, 2026-11-08).
  { id: "Qwen/Qwen3.6-35B-A3B-FP8", structured: true, params: { chat_template_kwargs: { enable_thinking: false } } },
  { id: "z-ai/glm-5.3-flash", structured: true },
  { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", structured: false },
];

/**
 * Y5, settled by the live compare on 2026-11-08 (`data/yield-model-compare.md`): Qwen with thinking off was valid 3/3
 * at about 1.9 s. GLM was valid 3/3 but took 18-23 s, past the Worker's per-call timeout, so on the chain it would only
 * delay the fallback. DeepSeek returned no answer in 3/3 (its reasoning used up max_tokens) and took about 20 s.
 * So: Qwen, then the rule order.
 */
export const YIELD_MODEL_CHAIN: readonly string[] = ["Qwen/Qwen3.6-35B-A3B-FP8"];

export const isTeeModel = (id: string): boolean => YIELD_TEE_MODELS.some((m) => m.id === id);
