// Guard data types (docs/final-idea.md §11.5.2). Times exposed in JSON are `U64` (nanoseconds as strings) so
// JS readers such as Key Doctor and the Guard MCP do not lose precision.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{near, AccountId, PublicKey};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardPolicy {
    /// yoctoNEAR per request.
    pub max_per_tx: U128,
    /// yoctoNEAR the Guard may self-approve in a rolling 24 h window. The real cap (§11.5.7).
    pub max_per_day: U128,
    /// Open requests per agent; stops an agent from burning bonds with a flood of proposals.
    pub max_pending_per_agent: u32,
    /// Balance the Guard keeps for its own storage.
    pub min_reserve: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentInfo {
    pub label: String,
    pub enabled: bool,
    /// Its account is not confirmed yet, so it cannot request. Separate from `enabled`, which only the DAO sets.
    pub creating: bool,
    /// Requests whose proposal still waits on the DAO (statuses `Submitted` and `Pending`).
    pub pending: u32,
    /// This agent's share of `spent_in_window`, valid only while `spent_window` is the Guard's current window.
    pub spent: U128,
    pub spent_window: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WhitelistEntry {
    pub label: String,
    pub max_per_tx: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decision {
    Auto,
    Pending,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RequestStatus {
    Submitted,
    AutoApproved,
    Pending,
    Executed,
    Rejected,
    Expired,
    Failed,
}

impl RequestStatus {
    pub fn is_final(self) -> bool {
        matches!(self, Self::Executed | Self::Rejected | Self::Expired | Self::Failed)
    }

    /// Counted in `AgentInfo::pending`: the proposal is not created or still waits for the council.
    pub fn holds_pending(self) -> bool {
        matches!(self, Self::Submitted | Self::Pending)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RequestRecord {
    pub request_id: String,
    pub agent: AccountId,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub memo: String,
    pub decision: Decision,
    /// Reason codes when `decision` is `Pending` (§11.5.4).
    pub reasons: Vec<String>,
    pub proposal_id: Option<u64>,
    pub status: RequestStatus,
    pub created_at: U64,
    pub updated_at: U64,
    /// The amount was added to `spent_in_window` and not refunded.
    pub counted_in_window: bool,
    /// Set on a step of this plan; `agent` is then the Guard itself.
    pub plan_id: Option<u32>,
}

/// `new` input: one agent.
#[near(serializers = [json])]
pub struct AgentInput {
    pub account_id: AccountId,
    pub label: String,
    /// Set: the Guard creates `account_id`, which must be its direct subaccount, with this function-call key.
    /// Unset: an agent account that already exists elsewhere.
    pub public_key: Option<PublicKey>,
}

/// `new` input: one whitelisted receiver.
#[near(serializers = [json])]
pub struct WhitelistInput {
    pub account_id: AccountId,
    pub label: String,
    pub max_per_tx: Option<U128>,
}

/// What one step does (§4.11, §11.11.2). `Swap` is last so the borsh bytes of stored plans stay valid.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlanAction {
    Transfer {
        receiver_id: AccountId,
    },
    /// Stored whole: `execute_plan_step` takes only a plan id, so a caller cannot change any of it.
    Call {
        target: AccountId,
        method: String,
        args_base64: Base64VecU8,
        deposit: U128,
        gas: U64,
    },
    /// DCA (§11.11.3, 4c). Sells `amount_per_run` NEAR on the network's Rhea exchange (`policy::dex_for`);
    /// `min_amount_out` is set at run time from a quote.
    Swap {
        pool_id: u64,
        token_out: AccountId,
        max_slippage_bps: u16,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanPauseReason {
    InsufficientBalance,
    GuardLowNear,
    Owner,
    Failures,
}

/// §4.11. `next_run_at` is `None` once the plan ended. `runs_done` counts runs the Guard approved and the DAO did
/// not report as failed, so a skipped run stays to do.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub plan_id: u32,
    pub action: PlanAction,
    pub strategy_id: String,
    pub token_in: String,
    pub amount_per_run: U128,
    pub interval_sec: u32,
    pub runs_total: u32,
    pub runs_done: u32,
    pub start_at: U64,
    pub next_run_at: Option<U64>,
    pub status: PlanStatus,
    pub pause_reason: Option<PlanPauseReason>,
}

/// `create_plan` input.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct PlanInput {
    pub action: PlanAction,
    pub strategy_id: String,
    /// `""` is NEAR, as in a Sputnik `Transfer`. The only value before GĐ23.
    pub token_in: String,
    pub amount_per_run: U128,
    pub interval_sec: u32,
    pub runs_total: u32,
    /// ns. Already past means the first step is due at once.
    pub start_at: U64,
}
