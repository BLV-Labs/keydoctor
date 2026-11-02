// GĐ15 spike (docs/final-idea.md §13.6): the smallest Guard that proves a contract member of a Sputnik v2 DAO
// can create a transfer proposal and approve it itself, with the money leaving in the same transaction.
// GĐ16 replaces this with the full contract in §11.5 (limits, whitelist, request records, sync, events).
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ON_ADDED: Gas = Gas::from_tgas(120);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(80);
const GAS_ON_VOTED: Gas = Gas::from_tgas(10);

#[ext_contract(ext_dao)]
#[allow(dead_code)]
trait SputnikDao {
    fn add_proposal(&mut self, proposal: Value) -> u64;
    // Recent Sputnik v2 builds require `proposal` (ERR_WRONG_KIND); older builds ignore the extra field.
    fn act_proposal(&mut self, id: u64, action: String, proposal: Value, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    dao_id: AccountId,
    /// The only account allowed to call `request_transfer` in the spike.
    agent_id: AccountId,
    /// yoctoNEAR, copied from the DAO's `get_policy().proposal_bond` at init.
    proposal_bond: U128,
}

#[near]
impl Guard {
    #[init]
    pub fn new(dao_id: AccountId, agent_id: AccountId, proposal_bond: U128) -> Self {
        Self { dao_id, agent_id, proposal_bond }
    }

    /// Creates a NEAR transfer proposal on the DAO (the Guard pays the bond), then votes to approve it.
    /// Returns the proposal id once the vote went through.
    pub fn request_transfer(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        require!(env::predecessor_account_id() == self.agent_id, "UNKNOWN_AGENT");
        require!(amount.0 > 0, "INVALID_AMOUNT");
        let kind = transfer_kind(&receiver_id, amount);
        let description = format!(
            "[KD-GUARD] request=spike agent={} decision=auto reasons=- memo=GD15 spike",
            self.agent_id
        );
        log_gas("request_transfer");
        ext_dao::ext(self.dao_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(self.proposal_bond.0))
            .with_static_gas(GAS_ADD_PROPOSAL)
            .add_proposal(json!({ "description": description, "kind": kind }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_ADDED).on_added(kind))
    }

    #[private]
    pub fn on_added(&mut self, kind: Value, #[callback_result] added: Result<u64, PromiseError>) -> Promise {
        let id = added.unwrap_or_else(|_| env::panic_str("ADD_PROPOSAL_FAILED"));
        log_gas("on_added");
        env::log_str(&format!("proposal_id={id}"));
        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_ACT_PROPOSAL)
            .act_proposal(id, "VoteApprove".to_string(), kind, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VOTED).on_voted(id))
    }

    #[private]
    pub fn on_voted(&mut self, id: u64, #[callback_result] voted: Result<(), PromiseError>) -> u64 {
        if voted.is_err() {
            env::panic_str("ACT_PROPOSAL_FAILED");
        }
        log_gas("on_voted");
        id
    }

    pub fn get_config(&self) -> Value {
        json!({ "dao_id": self.dao_id, "agent_id": self.agent_id, "proposal_bond": self.proposal_bond })
    }

    pub fn kd_guard_info(&self) -> Value {
        json!({ "standard": "kd_guard", "version": "0.1.0-spike", "dao_id": self.dao_id })
    }
}

/// `ProposalKind::Transfer` as Sputnik v2 expects it; `token_id = ""` means NEAR (§11.3 #8).
fn transfer_kind(receiver_id: &AccountId, amount: U128) -> Value {
    json!({ "Transfer": { "token_id": "", "receiver_id": receiver_id, "amount": amount, "msg": null } })
}

fn log_gas(step: &str) {
    env::log_str(&format!("gas step={step} used_ggas={}", env::used_gas().as_ggas()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn guard() -> Guard {
        Guard::new(accounts(0), accounts(1), U128(1_000_000_000_000_000_000_000_000))
    }

    #[test]
    fn transfer_kind_matches_sputnik_shape() {
        // The DAO rejects any other shape, so the spike would fail on chain, not here.
        let kind = transfer_kind(&accounts(2), U128(5));
        assert_eq!(
            kind,
            json!({ "Transfer": { "token_id": "", "receiver_id": "charlie", "amount": "5", "msg": null } })
        );
    }

    #[test]
    #[should_panic(expected = "UNKNOWN_AGENT")]
    fn stranger_cannot_request() {
        // Only the registered agent may spend the Guard's bond.
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(3)).build());
        let _ = guard().request_transfer(accounts(2), U128(5));
    }

    #[test]
    #[should_panic(expected = "INVALID_AMOUNT")]
    fn zero_amount_is_refused() {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(1)).build());
        let _ = guard().request_transfer(accounts(2), U128(0));
    }
}
