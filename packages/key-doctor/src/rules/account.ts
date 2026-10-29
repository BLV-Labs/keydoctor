import type { KeyInfo } from "../types.ts";
import type { RuleHit } from "./key.ts";
import { FA_MANY_MIN, FA_MULTIPLE_MIN } from "./thresholds.ts";

export function countKeys(keys: KeyInfo[]) {
  const edFullAccess = keys.filter((k) => k.curve === "ed25519" && k.permission.type === "full_access");
  return {
    edKeys: edFullAccess.map((k) => k.public_key),
    nEd: edFullAccess.length,
    nMl: keys.filter((k) => k.curve === "ml_dsa").length,
    fullAccess: keys.filter((k) => k.permission.type === "full_access").length,
    functionCall: keys.filter((k) => k.permission.type === "function_call").length,
    unused: keys.filter((k) => k.use_count === 0).length,
  };
}

/** An account is PQ-ready when it has an ML-DSA key and no full-access ed25519 key left. */
export const isPqReady = (counts: Pick<ReturnType<typeof countKeys>, "nMl" | "nEd">): boolean =>
  counts.nMl >= 1 && counts.nEd === 0;

/** Rules over the whole key set of one account. */
export function accountRules(keys: KeyInfo[]): RuleHit[] {
  const { edKeys, nEd, nMl } = countKeys(keys);
  const hits: RuleHit[] = [];
  const many = nEd >= FA_MANY_MIN;
  if (many) hits.push({ rule_id: "FA_MANY", scope: "account", key_ids: edKeys, evidence: { full_access_ed25519: nEd } });
  if (!many && nEd >= FA_MULTIPLE_MIN) {
    hits.push({ rule_id: "FA_MULTIPLE", scope: "account", key_ids: edKeys, evidence: { full_access_ed25519: nEd } });
  }
  if (nMl >= 1 && nEd >= 1) {
    hits.push({
      rule_id: "PQ_PARTIAL",
      scope: "account",
      key_ids: edKeys,
      evidence: { ml_dsa: nMl, full_access_ed25519: nEd },
    });
  }
  if (keys.length >= 1 && nMl === 0) hits.push({ rule_id: "PQ_NONE", scope: "account", key_ids: [], evidence: { ml_dsa: 0 } });
  return hits;
}
