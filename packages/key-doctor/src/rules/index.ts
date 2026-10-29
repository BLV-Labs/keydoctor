import type { Flag, KeyInfo } from "../types.ts";
import { accountKind } from "../parse.ts";
import { ruleMessages } from "../messages.ts";
import { accountRules } from "./account.ts";
import { keyRules, type RuleHit } from "./key.ts";
import { RULE_ORDER, RULE_SEVERITY, SEVERITY_RANK } from "./thresholds.ts";

const orderOf = (id: string): number => RULE_ORDER.indexOf(id as (typeof RULE_ORDER)[number]);

/** Runs every rule over one account's keys; returns sorted flags and keys with `flag_ids` set. */
export function evaluateKeys(accountId: string, keys: KeyInfo[]): { flags: Flag[]; keys: KeyInfo[] } {
  const hits: RuleHit[] = [...accountRules(keys), ...keyRules(keys)];
  const keyPos = new Map(keys.map((k, i) => [k.public_key, i]));
  const position = (h: RuleHit) => (h.public_key === undefined ? -1 : (keyPos.get(h.public_key) ?? -1));

  const sorted = [...hits].sort(
    (a, b) =>
      SEVERITY_RANK[RULE_SEVERITY[b.rule_id]] - SEVERITY_RANK[RULE_SEVERITY[a.rule_id]] ||
      orderOf(a.rule_id) - orderOf(b.rule_id) ||
      position(a) - position(b),
  );

  const flags: Flag[] = sorted.map((h) => ({
    rule_id: h.rule_id,
    severity: RULE_SEVERITY[h.rule_id],
    scope: h.scope,
    account_id: accountId,
    ...(h.public_key === undefined ? {} : { public_key: h.public_key }),
    evidence: h.evidence,
    messages: ruleMessages(h.rule_id, h.evidence, {
      receiverId: h.receiver_id !== undefined && accountKind(h.receiver_id) !== null ? h.receiver_id : null,
    }),
  }));

  const withIds = keys.map((key) => {
    const ids = hits
      .filter((h) => h.public_key === key.public_key || h.key_ids?.includes(key.public_key))
      .map((h) => h.rule_id)
      .sort((a, b) => orderOf(a) - orderOf(b));
    return { ...key, flag_ids: ids };
  });
  return { flags, keys: withIds };
}
