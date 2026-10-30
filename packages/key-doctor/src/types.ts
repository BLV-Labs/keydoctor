// Canonical data contracts: docs/final-idea.md §4.
// Do not change a contract silently: bump its schema_version and say so in the commit.

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type Severity = "high" | "cleanup" | "note";
export type Status = Severity | "ok";
export type Network = "mainnet" | "testnet";

/** User-facing text. The bot and the dashboard reuse it verbatim. */
export interface Messages {
  vi: { title: string; explain: string; fix: string };
  en: { title: string; explain: string; fix: string };
}

// ---------------------------------------------------------------------------
// kd.report.v1 (§4.1)
// ---------------------------------------------------------------------------

export type KeyPermission =
  | { type: "full_access" }
  | {
      type: "function_call";
      receiver_id: string;
      /** Empty = the key may call any method. */
      method_names: string[];
      /** yoctoNEAR; null = unlimited allowance. */
      allowance_yocto: string | null;
    };

export interface KeyInfo {
  public_key: string;
  curve: "ed25519" | "ml_dsa" | "unknown";
  permission: KeyPermission;
  receiver_exists?: boolean | null;
  nonce: string;
  use_count: number | null;
  created: {
    /** floor(nonce / 10^6) = block where the key was added. */
    block_height: number | null;
    at: string | null;
    source: "nonce_estimate" | "indexer" | "unknown";
  };
  age_days: number | null;
  flag_ids: string[];
}

export interface Flag {
  rule_id: string;
  severity: Severity;
  scope: "key" | "account" | "dao";
  account_id?: string;
  public_key?: string;
  evidence: Record<string, unknown>;
  messages: Messages;
}

export interface Member {
  account_id: string;
  account_kind: "named" | "implicit" | "eth_implicit" | "missing";
  roles: string[];
  status: Status;
  /** Has an ML-DSA key AND no Ed25519 full-access key left. */
  pq_ready: boolean;
  counts: { full_access: number; function_call: number; ml_dsa: number; unused: number };
  keys: KeyInfo[];
  flags: Flag[];
  /** A per-member failure; it never fails the whole scan. */
  error: string | null;
}

export interface TransferVotePolicy {
  role: string;
  weight_kind: string;
  /** Verbatim from get_policy. */
  threshold: unknown;
  approvals_needed: number | null;
}

export interface DaoRole {
  name: string;
  kind: "group" | "everyone" | "member";
  members: string[];
  can_approve_transfer: boolean;
}

export interface ReportSummary {
  status: Status;
  council_size: number;
  members_scanned: number;
  members_high: number;
  members_cleanup: number;
  members_ok: number;
  pq_ready: number;
  keys_total: number;
  keys_full_access: number;
  keys_unused: number;
}

export interface KdReport {
  schema_version: "kd.report.v1";
  ruleset_version: string;
  generated_at: string;
  chain: { network: Network; block_height: number; block_timestamp: string };
  target: { type: "dao" | "account"; id: string };
  dao?: {
    roles: DaoRole[];
    transfer_vote_policy: TransferVotePolicy[];
    proposal_bond_yocto: string;
  };
  summary: ReportSummary;
  /** Exactly one element when the target is an account. */
  members: Member[];
  dao_flags: Flag[];
  errors: string[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// kd.report_summary.v1 (§4.2)
// ---------------------------------------------------------------------------

export interface KdReportSummary extends Omit<KdReport, "schema_version" | "members"> {
  schema_version: "kd.report_summary.v1";
  members: Omit<Member, "keys">[];
}

// ---------------------------------------------------------------------------
// kd.diff.v1 (§4.3)
// ---------------------------------------------------------------------------

export type ChangeType =
  | "member_added"
  | "member_removed"
  | "role_changed"
  | "key_added"
  | "key_removed"
  | "flag_raised"
  | "flag_cleared"
  | "pq_ready_changed";

export interface Change {
  type: ChangeType;
  severity: Severity;
  account_id: string;
  public_key?: string;
  rule_id?: string;
  details?: Record<string, unknown>;
  messages: { vi: string; en: string };
}

export interface KdDiff {
  schema_version: "kd.diff.v1";
  target: { type: "dao" | "account"; id: string };
  network: Network;
  from: { generated_at: string; block_height: number } | null;
  to: { generated_at: string; block_height: number };
  is_baseline: boolean;
  baseline_updated: boolean;
  summary: {
    has_changes: boolean;
    highest_severity: Severity | null;
    status_before: Status | null;
    status_after: Status;
    counts: Partial<Record<ChangeType, number>>;
  };
  changes: Change[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// kd.alert.v1 (§4.4)
// ---------------------------------------------------------------------------

export type AlertKind =
  | "voter_new_full_access_key"
  | "governance_change_proposal"
  | "code_upgrade_proposal"
  | "daily_changes";

export type Vote = "Approve" | "Reject" | "Remove";

export interface ProposalInfo {
  id: number;
  kind_label: string;
  description: string;
  proposer: string;
  transfer?: { token_id: string; receiver_id: string; amount: string };
  status: string;
  votes: Record<string, Vote>;
  approvals_needed: number | null;
  approvals_have: number;
  pending_voters: string[];
  executed: boolean;
  ui_url: string | null;
}

export interface KdAlert {
  schema_version: "kd.alert.v1";
  /** `{network}:{target}:{kind}:{proposal_id or date}:{account_id or "-"}` */
  alert_id: string;
  created_at: string;
  network: Network;
  target: string;
  severity: Severity;
  kind: AlertKind;
  /** True when the proposal already executed (one-vote DAO). */
  after_the_fact: boolean;
  proposal?: ProposalInfo;
  evidence?: {
    account_id: string;
    public_key: string;
    key_added_block: number;
    key_added_at_est: string;
    hours_before_vote_seen: number;
  };
  diff?: KdDiff;
  messages: {
    vi: { title: string; body: string; action: string };
    en: { title: string; body: string; action: string };
  };
}

// ---------------------------------------------------------------------------
// checkProposals and ProposalWatchState (§4.5)
// ---------------------------------------------------------------------------

export interface ProposalWatchState {
  last_proposal_id: number;
  /** Keyed by proposal id. */
  pending: Record<
    string,
    {
      kind_label: string;
      votes_seen: Record<string, Vote>;
      first_seen_at: string;
    }
  >;
}

export interface CheckProposalsOptions {
  network?: Network;
  /** One endpoint, or several tried in order on rate limits and transport failures. Default: DEFAULT_RPC_URLS. */
  rpcUrl?: string | readonly string[];
  /** Default 48. */
  newKeyWindowHours?: number;
  /** e.g. "https://<ui>/{dao}/proposals/{id}" */
  proposalUiUrlTemplate?: string;
}

export interface CheckProposalsResult {
  alerts: KdAlert[];
  state: ProposalWatchState;
  errors: string[];
}

// ---------------------------------------------------------------------------
// kd.watch_link.v1 (§4.6)
// ---------------------------------------------------------------------------

export interface KdWatchLink {
  schema_version: "kd.watch_link.v1";
  target: string;
  network: Network;
  link_private: string;
  link_group: string;
  expires_at: string;
  instructions: { vi: string; en: string };
}

// ---------------------------------------------------------------------------
// kd.error.v1 (§4.7)
// ---------------------------------------------------------------------------

export type KdErrorCode =
  | "INVALID_TARGET"
  | "NOT_FOUND"
  | "NOT_A_DAO"
  | "RPC_ERROR"
  | "RATE_LIMITED"
  | "LIMIT_EXCEEDED"
  | "UNAUTHORIZED"
  | "EXPIRED";

export interface KdError {
  schema_version: "kd.error.v1";
  code: KdErrorCode;
  message: { vi: string; en: string };
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Library options (§7)
// ---------------------------------------------------------------------------

export interface ScanOptions {
  network?: Network;
  /** One endpoint, or several tried in order on rate limits and transport failures. Default: DEFAULT_RPC_URLS. */
  rpcUrl?: string | readonly string[];
  /** Pin every query in the scan to this block. */
  blockHeight?: number;
  skipReceiverCheck?: boolean;
  /** Default 4. */
  concurrency?: number;
}
