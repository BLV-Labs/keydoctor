// Inputs of the Guard's `new`, mirrored from contracts/guard/src/types.rs so `create` rejects bad input before any
// money moves. The Guard checks them again in its own `new`.
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, require, AccountId, NearToken, PublicKey};

// contracts/guard/src/lib.rs, §11.5.10
pub const MAX_AGENTS: usize = 10;
pub const MAX_WHITELIST: usize = 50;
pub const MAX_GUARDIANS: usize = 5;
pub const MAX_LABEL_CHARS: usize = 64;
// AGENT_GAS_FUND in contracts/guard/src/lib.rs: what the new Guard pays for each agent account it creates.
pub const AGENT_GAS_FUND: NearToken = NearToken::from_millinear(500);

#[near(serializers = [json])]
pub struct GuardPolicy {
    pub max_per_tx: U128,
    pub max_per_day: U128,
    pub max_pending_per_agent: u32,
    pub min_reserve: U128,
}

#[near(serializers = [json])]
pub struct AgentInput {
    pub account_id: AccountId,
    pub label: String,
    pub public_key: Option<PublicKey>,
}

#[near(serializers = [json])]
pub struct WhitelistInput {
    pub account_id: AccountId,
    pub label: String,
    pub max_per_tx: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GuardRecord {
    pub dao_id: AccountId,
    pub name: String,
    /// ns
    pub created_at: U64,
    /// false while the Guard account is being created.
    pub ready: bool,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct GuardView {
    pub guard_id: AccountId,
    pub dao_id: AccountId,
    pub name: String,
    pub created_at: U64,
    pub ready: bool,
}

pub fn validate_inputs(agents: &[AgentInput], whitelist: &[WhitelistInput], guardians: &[AccountId]) {
    require!(agents.len() <= MAX_AGENTS, "TOO_MANY_AGENTS");
    require!(whitelist.len() <= MAX_WHITELIST, "TOO_MANY_WHITELIST");
    require!(guardians.len() <= MAX_GUARDIANS, "TOO_MANY_GUARDIANS");
    let labels = agents.iter().map(|a| &a.label).chain(whitelist.iter().map(|w| &w.label));
    for label in labels {
        require!(label.chars().count() <= MAX_LABEL_CHARS, "LABEL_TOO_LONG");
    }
}
