// Plan §2 and Y5: only models on this list may be called, and a failure never falls through to a model off it.
// Every id is a Private TEE model on NEAR AI Cloud, checked against /v1/models on 2026-11-08. Look-alike ids from
// other providers (for example `deepseek/...`, owned_by deepseek) are not TEE models and must never be added.

export interface TeeModel {
  id: string;
  /** /v1/models lists `structured_outputs`: the call can send a JSON schema. Without it, code parses free text. */
  structured: boolean;
}

export const YIELD_TEE_MODELS: readonly TeeModel[] = [
  { id: "Qwen/Qwen3.6-35B-A3B-FP8", structured: true },
  { id: "z-ai/glm-5.3-flash", structured: true },
  { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", structured: false },
];

/** Y5: tried in this order, then the rule order. DeepSeek moves first only if the live compare says so. */
export const YIELD_MODEL_CHAIN: readonly string[] = ["Qwen/Qwen3.6-35B-A3B-FP8", "z-ai/glm-5.3-flash"];

export const isTeeModel = (id: string): boolean => YIELD_TEE_MODELS.some((m) => m.id === id);
