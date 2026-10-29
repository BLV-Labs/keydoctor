import type { Network, Severity } from "../types.ts";

// Changing any number in this file means bumping RULESET_VERSION.
export const RULESET_VERSION = "2026-11-01";

export const RULE_ORDER = [
  "FA_MANY",
  "DAO_ADMIN",
  "FC_DAO_VOTE",
  "FA_MULTIPLE",
  "PQ_PARTIAL",
  "FA_OLD",
  "KEY_UNUSED",
  "FC_UNLIMITED_ALLOWANCE",
  "FC_ANY_METHOD",
  "FC_DEAD_RECEIVER",
  "FA_BOT_LIKE",
  "PQ_NONE",
  "COUNCIL_SMALL",
] as const;

export type RuleId = (typeof RULE_ORDER)[number];

export const RULE_SEVERITY: Record<RuleId, Severity> = {
  FA_MANY: "high",
  DAO_ADMIN: "high",
  FC_DAO_VOTE: "high",
  FA_MULTIPLE: "cleanup",
  PQ_PARTIAL: "cleanup",
  FA_OLD: "cleanup",
  KEY_UNUSED: "cleanup",
  FC_UNLIMITED_ALLOWANCE: "cleanup",
  FC_ANY_METHOD: "cleanup",
  FC_DEAD_RECEIVER: "cleanup",
  FA_BOT_LIKE: "cleanup",
  PQ_NONE: "note",
  COUNCIL_SMALL: "note",
};

export const SEVERITY_RANK: Record<Severity | "ok", number> = { ok: 0, note: 1, cleanup: 2, high: 3 };

// Rule thresholds.
export const FA_MANY_MIN = 5;
export const FA_MULTIPLE_MIN = 2;
export const FA_OLD_DAYS = 730;
export const FA_BOT_LIKE_USES = 1000;
export const COUNCIL_SMALL_MAX = 2;

// A member who can pass a policy proposal alone is a DAO admin.
export const ADMIN_LABELS = [
  "policy",
  "policy_add_or_update_role",
  "policy_remove_role",
  "policy_update_default_vote_policy",
  "policy_update_parameters",
] as const;
export const ADMIN_APPROVALS = 1;

// Key age from the nonce.
export const BLOCK_TIME_MS = 1200;
export const MS_PER_DAY = 86_400_000;
export const NONCE_BLOCK_DIVISOR = 1_000_000;
export const GENESIS_HEIGHT: Record<Network, number> = { mainnet: 9_820_210, testnet: 42_376_888 };

// Caps and bounds.
export const REQUEST_BUDGET = 45;
export const MAX_MEMBERS = 21;
export const MAX_ROLES = 50;
export const MAX_KEYS = 100;
// Total Group entries across all policy roles, council or not.
export const MAX_GROUP_ENTRIES = 500;
// Longest role name echoed into a limitation line.
export const ROLE_LABEL_MAX_LEN = 32;
export const CONCURRENCY_DEFAULT = 4;
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 8;
export const RPC_TIMEOUT_MS = 15_000;

// checkProposals (§4.5, §5.2). Window for "voter has a new full-access key".
export const NEW_KEY_WINDOW_HOURS = 48;
// Per call: proposals read (pending first, then new) and voters scanned; the rest wait for the next call.
export const MAX_PROPOSALS_PER_CHECK = 12;
export const MAX_VOTER_SCANS_PER_CHECK = 8;
// Proposal descriptions are chain text: cut before they go into ProposalInfo.
export const DESCRIPTION_MAX_LEN = 280;

// NEAR account id length bounds.
export const ACCOUNT_ID_MIN_LEN = 2;
export const ACCOUNT_ID_MAX_LEN = 64;
