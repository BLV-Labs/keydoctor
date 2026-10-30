// UC8 key cleanup plan: pure functions over one kd.report.v1 member. Progress comes from chain data only.
import type { KeyInfo, Member } from "key-doctor";

export const METEOR_URL = "https://wallet.meteorwallet.app/wallet";
/** Rough cap on actions per transaction (UC8 safety rule 6); more keys are split across transactions. */
export const MAX_ACTIONS_PER_TX = 100;

export type Level = "safe" | "full";
export type StepId = "revoke_app_keys" | "delete_old_full_access" | "add_ml_dsa" | "test_sign" | "delete_remaining_ed25519";

/** App keys worth revoking: those any rule flagged (unused, dead receiver, too broad, can vote). */
const APP_KEY_RULES = new Set(["KEY_UNUSED", "FC_DEAD_RECEIVER", "FC_ANY_METHOD", "FC_UNLIMITED_ALLOWANCE", "FC_DAO_VOTE"]);

const isFullAccess = (k: KeyInfo) => k.permission.type === "full_access";
const isEdFullAccess = (k: KeyInfo) => isFullAccess(k) && k.curve === "ed25519";
const isMlFullAccess = (k: KeyInfo) => isFullAccess(k) && k.curve === "ml_dsa";

export function appKeysToRevoke(m: Member): KeyInfo[] {
  return m.keys.filter((k) => k.permission.type === "function_call" && k.flag_ids.some((id) => APP_KEY_RULES.has(id)));
}

/**
 * Old or never-used Ed25519 full-access keys, never used first, then oldest first.
 * When every full-access key qualifies, the most used one is kept out of the list so the account keeps a way in.
 */
export function oldFullAccessKeys(m: Member): { remove: KeyInfo[]; keep: KeyInfo | null } {
  const full = m.keys.filter(isFullAccess);
  const qualifies = (k: KeyInfo) => isEdFullAccess(k) && (k.use_count === 0 || k.flag_ids.includes("FA_OLD"));
  const sorted = full
    .filter(qualifies)
    .sort((a, b) => Number(b.use_count === 0) - Number(a.use_count === 0) || (a.created.block_height ?? 0) - (b.created.block_height ?? 0));
  if (sorted.length < full.length) return { remove: sorted, keep: null };
  const keep = [...sorted].sort((a, b) => (b.use_count ?? 0) - (a.use_count ?? 0) || (b.created.block_height ?? 0) - (a.created.block_height ?? 0))[0] ?? null;
  return { remove: sorted.filter((k) => k !== keep), keep };
}

export interface Step {
  id: StepId;
  number: number;
  done: boolean;
  /** Keys this step removes, in order; empty for steps done in Meteor's PQ screen. */
  keys: KeyInfo[];
  keep: KeyInfo | null;
}

export function planSteps(m: Member, level: Level): Step[] {
  const app = appKeysToRevoke(m);
  const old = oldFullAccessKeys(m);
  const ml = m.keys.filter(isMlFullAccess);
  const edLeft = m.keys.filter(isEdFullAccess);
  const steps: Step[] = [
    { id: "revoke_app_keys", number: 1, done: app.length === 0, keys: app, keep: null },
    { id: "delete_old_full_access", number: 2, done: old.remove.length === 0 && m.keys.some(isFullAccess), keys: old.remove, keep: old.keep },
    { id: "add_ml_dsa", number: 3, done: ml.length > 0, keys: [], keep: null },
    { id: "test_sign", number: 4, done: ml.some((k) => (k.use_count ?? 0) >= 1), keys: [], keep: null },
  ];
  if (level === "full") steps.push({ id: "delete_remaining_ed25519", number: 5, done: ml.length > 0 && edLeft.length === 0, keys: ml.length > 0 ? edLeft : [], keep: null });
  return steps;
}

export type GuardError = "UNKNOWN_KEY" | "LAST_FULL_ACCESS" | "SIGNER_KEY" | "NEEDS_TWO_FULL_ACCESS_LEFT" | "EMPTY";

export interface DeletePlan {
  ok: boolean;
  errors: GuardError[];
  /** DeleteKey actions split into transactions of at most MAX_ACTIONS_PER_TX. */
  transactions: { type: "DeleteKey"; public_key: string }[][];
}

/**
 * UC8 safety rules 1, 2 and 6, checked before any transaction is built. The dashboard never builds a
 * DeleteKey for the last full-access key, nor for the key the wallet signs with. When the wallet does not say
 * which key it uses, full-access keys may go only if at least two full-access keys stay.
 */
export function buildDeletePlan(m: Member, publicKeys: readonly string[], signerPublicKey: string | null): DeletePlan {
  const errors: GuardError[] = [];
  const wanted = [...new Set(publicKeys)];
  if (wanted.length === 0) errors.push("EMPTY");
  const byKey = new Map(m.keys.map((k) => [k.public_key, k]));
  if (wanted.some((pk) => !byKey.has(pk))) errors.push("UNKNOWN_KEY");
  const fullLeft = m.keys.filter((k) => isFullAccess(k) && !wanted.includes(k.public_key)).length;
  const deletesFull = wanted.some((pk) => byKey.get(pk)?.permission.type === "full_access");
  if (deletesFull && fullLeft === 0) errors.push("LAST_FULL_ACCESS");
  if (signerPublicKey !== null && wanted.includes(signerPublicKey)) errors.push("SIGNER_KEY");
  if (signerPublicKey === null && deletesFull && fullLeft < 2) errors.push("NEEDS_TWO_FULL_ACCESS_LEFT");
  if (errors.length > 0) return { ok: false, errors, transactions: [] };
  const actions = wanted.map((public_key) => ({ type: "DeleteKey" as const, public_key }));
  const transactions: DeletePlan["transactions"] = [];
  for (let i = 0; i < actions.length; i += MAX_ACTIONS_PER_TX) transactions.push(actions.slice(i, i + MAX_ACTIONS_PER_TX));
  return { ok: true, errors: [], transactions };
}

export const GUARD_TEXT: Record<GuardError, string> = {
  EMPTY: "No keys to delete.",
  UNKNOWN_KEY: "A listed key is no longer on the account. Rescan first.",
  LAST_FULL_ACCESS: "This would delete the last full-access key. Key Doctor never does that.",
  SIGNER_KEY: "This would delete the key that signs the transaction.",
  NEEDS_TWO_FULL_ACCESS_LEFT: "The wallet does not say which key it signs with, so at least two full-access keys must stay after this delete.",
};
