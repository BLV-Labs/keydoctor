// Guard data types (docs/final-idea.md §11.5.2). Times exposed in JSON are `U64` (nanoseconds as strings) so
// JS readers such as Key Doctor and the Guard MCP do not lose precision.
use near_sdk::json_types::{U128, U64};
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
