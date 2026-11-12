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
    // Report status without FA_RECENT, which follows the clock (key_added reports the new key).
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
  | "daily_changes"
  /** A Guard of the DAO added a transfer it did not approve itself (§5.4). */
  | "guard_request_pending"
  /** A Guard of the DAO approved a transfer within its limits (owner decision 2026-11-03, Guard plan D9). */
  | "guard_transfer_auto";

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
  /** Guard alerts only: read from the proposal description the Guard wrote (§11.5.6). */
  guard?: {
    guard_id: string;
    request_id: string;
    agent: string;
    decision: "auto" | "pending";
    /** Guard reason codes such as NOT_WHITELISTED; empty for auto. */
    reasons: string[];
    memo: string;
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
  /** The Guard factory that marks a DAO as an Agent Budget. Without it no `budget_alerts` are built. */
  budgetFactoryId?: string;
  /** Base of the links in `budget_alerts`. */
  dashboardUrl?: string;
}

export interface ListProposalsOptions {
  network?: Network;
  rpcUrl?: string | readonly string[];
  /** Newest proposals to read. Default 10. */
  limit?: number;
  /** Newest proposals to skip first, for paging (page n = offset (n - 1) * limit). Default 0. */
  offset?: number;
  proposalUiUrlTemplate?: string;
}

export interface ListProposalsResult {
  /** Newest first. */
  proposals: ProposalInfo[];
  /** Every proposal the DAO ever had (`get_last_proposal_id`). */
  total: number;
  errors: string[];
}

export interface CheckProposalsResult {
  alerts: KdAlert[];
  /** Owner actions on an Agent Budget (§9.5), in their own schema: `kd.alert.v1` does not change. */
  budget_alerts: KdBudgetAlert[];
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
// kd.preflight.v1 (§4.10)
// ---------------------------------------------------------------------------

export type PreflightVerdict = "allow" | "review" | "block";

export interface PreflightReason {
  /** A rule id, or a member error code when the keys could not be read. */
  code: string;
  severity: Severity;
  public_key?: string;
  /** One line: the flag title and explanation, or the member error text. */
  messages: { vi: string; en: string };
}

export interface KdPreflight {
  schema_version: "kd.preflight.v1";
  ruleset_version: string;
  network: Network;
  /** null when the keys could not be read at all (verdict review). */
  block_height: number | null;
  verdict: PreflightVerdict;
  account: { id: string; status: Status; flags: string[]; error: string | null };
  /** Empty when the verdict is allow. Most severe first. */
  reasons: PreflightReason[];
}

// ---------------------------------------------------------------------------
// kd.budget_alert.v1: Agent Budget plans and their messages (§4.11). kd.alert.v1 stays as it is.
// ---------------------------------------------------------------------------

export type PlanAction =
  | { type: "transfer"; receiver_id: string }
  | { type: "call"; target: string; method: string; args_base64: string; deposit: string; gas: string }
  /** Guard 1.4.0 DCA without a price floor. A 1.5.0 Guard refuses to create it and pauses a stored one. */
  | { type: "swap"; pool_id: number; token_out: string; max_slippage_bps: number }
  /** Guard 1.5.0 DCA. `min_out_per_near`: the least token_out base units one NEAR (10^24 yocto) may buy. */
  | { type: "swap_with_floor"; pool_id: number; token_out: string; max_slippage_bps: number; min_out_per_near: string };
export type PlanStatus = "active" | "paused" | "completed" | "cancelled";
export type PlanPauseReason =
  | "insufficient_balance"
  | "guard_low_near"
  | "owner"
  | "failures"
  | "price_floor_required"
  | null;

/** Stored on chain, in the Guard. Times are nanoseconds as strings, as the Guard's `get_plans` returns them. */
export interface Plan {
  plan_id: number;
  action: PlanAction;
  strategy_id: string;
  token_in: string;
  amount_per_run: string;
  interval_sec: number;
  runs_total: number;
  runs_done: number;
  start_at: string;
  next_run_at: string | null;
  status: PlanStatus;
  pause_reason: PlanPauseReason;
}

/** The Worker reads this from the chain and stores it in D1. */
export interface PlanStepResult {
  plan_id: number;
  run: number;
  status: "executed" | "skipped" | "failed";
  reason?: string;
  amount_in: string;
  amount_out?: string;
  price?: string;
  proposal_id?: number;
  tx_hash?: string;
  executed_at: string;
}

export type BudgetAlertKind = "budget_owner_action" | "plan_step_executed" | "plan_step_skipped" | "plan_paused" | "plan_completed";

export interface KdBudgetAlert {
  schema_version: "kd.budget_alert.v1";
  /**
   * `<network>:<budget>:<kind>:<plan_id>:<run>-<n>`. `n` tells apart messages that share a run, which §4.11's plain
   * `<run>` cannot: the slot (`due`) for a step, the count of failed steps for a pause.
   */
  alert_id: string;
  created_at: string;
  network: Network;
  budget: { dao_id: string; guard_id: string };
  kind: BudgetAlertKind;
  severity: Severity;
  muteable: boolean;
  owner_action?: {
    action: "withdraw" | "edit_rules" | "add_agent" | "disable_agent" | "remove_agent" | "create_plan" | "pause_plan" | "resume_plan" | "cancel_plan" | "pause_agents" | "upgrade_guard";
    proposal_id: number | null;
    summary: string;
  };
  plan?: Plan;
  step?: PlanStepResult;
  totals?: { spent: string; received: string | null; avg_price: string | null };
  links: { tx?: string; dashboard: string };
  messages: {
    vi: { title: string; body: string; action: string };
    en: { title: string; body: string; action: string };
  };
}

// ---------------------------------------------------------------------------
// kd.yield.v1 (yield plan YD1). A new contract: no existing schema changes.
// ---------------------------------------------------------------------------

/** Why a lending row is not a candidate. Floors (TVL to SOURCE_GAP) apply on mainnet only. */
export type YieldRejectReason =
  | "NOT_ALLOWLISTED"
  | "DEPOSIT_CLOSED"
  | "WITHDRAW_CLOSED"
  | "PRICE_UNKNOWN"
  | "PRICE_GAP"
  | "TVL_LOW"
  | "LIQUIDITY_LOW"
  | "SOURCE_MISSING"
  | "SOURCE_GAP";

export type YieldWarning = "APR_HIGH";

export interface YieldSource {
  name: "rhea-lend" | "rhea-api";
  /** Supply APR as a fraction (0.07 = 7%). */
  apr: number;
  at: string;
}

export interface YieldOpportunity {
  /** `rhea-lend:<token_id>:supply` */
  id: string;
  protocol: "rhea-lend";
  network: Network;
  token_id: string;
  /** From the code allowlist, never from chain or API text. */
  symbol: string;
  /** Supply APR from the Rhea Lend contract, a fraction. */
  apr: number;
  apy_reward: number | null;
  tvl_usd: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  sources: YieldSource[];
  /** True only when the row is on the DAO's network, so a proposal can act on it. */
  executable: boolean;
  /** Testnet rates and prices mean nothing: such rows skip the floors and must be shown as test data. */
  test_data: boolean;
  warnings: YieldWarning[];
}

export interface YieldRejected {
  id: string;
  network: Network;
  token_id: string;
  reasons: YieldRejectReason[];
}

export interface YieldHolding {
  token_id: string;
  symbol: string;
  decimals: number;
  /** Raw token units; null when the balance could not be read. */
  balance: string | null;
  /** Open (InProgress) Transfer proposals in this token. */
  open_transfers: { proposal_id: number; amount: string }[];
  /** balance minus open_transfers, never below 0; null when either could not be read. */
  available: string | null;
  error: string | null;
}

/** A supply the council could vote on. The member enters the amount, at most `max_amount`. */
export interface YieldSuggestion {
  opportunity_id: string;
  token_id: string;
  max_amount: string;
}

export interface KdYieldReport {
  schema_version: "kd.yield.v1";
  yield_ruleset_version: string;
  generated_at: string;
  chain: { network: Network; block_height: number; block_timestamp: string };
  dao: string;
  holdings: YieldHolding[];
  /** Candidates that passed the filter, highest APR first (the rule order). */
  opportunities: YieldOpportunity[];
  rejected: YieldRejected[];
  suggestions: YieldSuggestion[];
  /** User-facing notes; the bot and the dashboard reuse them verbatim. */
  notes: { vi: string; en: string }[];
  errors: string[];
  limitations: string[];
}

// ---------------------------------------------------------------------------
// kd.yield_advice.v1 (yield plan YD2): the order of a report's suggestions, with reasons. A new contract next to
// kd.yield.v1, which stays unchanged: code still owns every number and the report itself.
// ---------------------------------------------------------------------------

/** Why the rule order is shown instead of a model order. */
export type YieldAdviceFallback =
  /** NEAR_AI_API_KEY is not set. */
  | "NO_KEY"
  /** Every model on the chain failed: error, timeout, or output that did not pass validateAdvice. */
  | "MODEL_FAILED"
  /** The model-call cap for this Worker was reached. */
  | "BUSY"
  /** A path that never calls the model (open /mcp) found no fresh cached advice. */
  | "NO_CACHE";

export interface YieldAdviceItem {
  opportunity_id: string;
  /** AI-assisted text, or null when the model gave none or validateAdvice dropped it (a number not in the evidence). */
  reason: { vi: string; en: string } | null;
}

export interface KdYieldAdvice {
  schema_version: "kd.yield_advice.v1";
  generated_at: string;
  dao: string;
  network: Network;
  by: "model" | "rules";
  /** A model on the TEE list, null for the rule order. */
  model: string | null;
  /** The NEAR AI response id, for GET /v1/signature/{id}. */
  generation_id: string | null;
  fallback: YieldAdviceFallback | null;
  /** The suggestions this advice was made for; adviceFresh compares them with a newer report. */
  basis: { opportunity_id: string; apr: number; max_amount: string }[];
  /** Every suggestion of the report, exactly once, in the order to show. */
  items: YieldAdviceItem[];
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
