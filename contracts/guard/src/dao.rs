// The Sputnik v2 calls the Guard makes (docs/final-idea.md §11.3) and the parts of their results it reads.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{ext_contract, near, AccountId};

#[ext_contract(ext_dao)]
#[allow(dead_code)]
pub trait SputnikDao {
    fn add_proposal(&mut self, proposal: Value) -> u64;
    // Recent Sputnik v2 builds require `proposal` (ERR_WRONG_KIND); older builds ignore the extra field.
    fn act_proposal(&mut self, id: u64, action: String, proposal: Value, memo: Option<String>);
    fn get_proposal(&self, id: u64) -> ProposalView;
    fn get_policy(&self) -> DaoPolicyView;
}

/// Fields of `get_policy` the Guard caches. Unknown fields are ignored.
#[near(serializers = [json])]
pub struct DaoPolicyView {
    pub proposal_bond: U128,
    pub proposal_period: U64,
}

/// Fields of `get_proposal` that `sync_request` reads.
#[near(serializers = [json])]
pub struct ProposalView {
    pub status: String,
    pub submission_time: U64,
}

/// `ProposalKind::Transfer` as Sputnik v2 expects it; `token_id = ""` means NEAR (§11.3 #8).
pub fn transfer_kind(receiver_id: &AccountId, amount: U128) -> Value {
    json!({ "Transfer": { "token_id": "", "receiver_id": receiver_id, "amount": amount, "msg": null } })
}

/// `ProposalKind::FunctionCall` with one action. The Guard's role needs `call:AddProposal` and `call:VoteApprove`.
pub fn function_call_kind(target: &AccountId, method: &str, args: &Base64VecU8, deposit: U128, gas: U64) -> Value {
    json!({ "FunctionCall": { "receiver_id": target, "actions": [{
        "method_name": method, "args": args, "deposit": deposit, "gas": gas,
    }]}})
}
