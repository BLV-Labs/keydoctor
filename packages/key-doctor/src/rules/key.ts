import type { KeyInfo } from "../types.ts";
import type { MessageRuleId } from "../messages.ts";
import { FA_BOT_LIKE_USES, FA_OLD_DAYS } from "./thresholds.ts";

export interface RuleHit {
  rule_id: MessageRuleId;
  scope: "key" | "account";
  /** Key-scope hits: the key. */
  public_key?: string;
  /** Account-scope hits: the keys that carry this rule id in `flag_ids`. */
  key_ids?: string[];
  evidence: Record<string, unknown>;
}

/** Rules that look at one key at a time, in key order. */
export function keyRules(keys: KeyInfo[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const key of keys) {
    const fullAccess = key.permission.type === "full_access";
    if (fullAccess && (key.created.source === "unknown" || (key.age_days !== null && key.age_days > FA_OLD_DAYS))) {
      hits.push({ rule_id: "FA_OLD", scope: "key", public_key: key.public_key, evidence: { age_days: key.age_days } });
    }
    if (key.use_count === 0) {
      hits.push({ rule_id: "KEY_UNUSED", scope: "key", public_key: key.public_key, evidence: { use_count: 0 } });
    }
    if (fullAccess && key.use_count !== null && key.use_count >= FA_BOT_LIKE_USES) {
      hits.push({
        rule_id: "FA_BOT_LIKE",
        scope: "key",
        public_key: key.public_key,
        evidence: { use_count: key.use_count },
      });
    }
  }
  return hits;
}
