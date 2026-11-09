// The Sputnik v2 calls the Guard makes (docs/final-idea.md §11.3) and the parts of their results it reads.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{ext_contract, near, AccountId, Gas};

// Gas of the two swap actions inside the DAO's `act_proposal`. 150 Tgas is the start for `ft_transfer_call` (Rhea's
// own UI attaches 180); the sandbox run measures it (docs/stories/epics/guard/gd31-dca-plan.md, Change 1.4).
pub const GAS_NEAR_DEPOSIT: Gas = Gas::from_tgas(5);
pub const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(150);

#[ext_contract(ext_dao)]
#[allow(dead_code)]
pub trait SputnikDao {
    fn add_proposal(&mut self, proposal: Value) -> u64;
    // Recent Sputnik v2 builds require `proposal` (ERR_WRONG_KIND); older builds ignore the extra field.
    fn act_proposal(&mut self, id: u64, action: String, proposal: Value, memo: Option<String>);
    fn get_proposal(&self, id: u64) -> ProposalView;
    fn get_policy(&self) -> DaoPolicyView;
}

/// Rhea (Ref Finance) exchange view the swap step quotes with.
#[ext_contract(ext_exchange)]
#[allow(dead_code)]
pub trait RheaExchange {
    fn get_return(&self, pool_id: u64, token_in: AccountId, amount_in: U128, token_out: AccountId) -> U128;
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

/// The DCA swap as one proposal: wrap the NEAR, then `ft_transfer_call` it to the exchange with a one-action swap
/// message that refuses less than `min_out`. Built at run time because `min_out` comes from the quote.
pub fn swap_kind(
    wrap: &str,
    exchange: &str,
    amount: U128,
    pool_id: u64,
    token_out: &AccountId,
    min_out: u128,
) -> Value {
    let msg = json!({ "actions": [{ "pool_id": pool_id, "token_in": wrap, "token_out": token_out,
        "amount_in": amount, "min_amount_out": U128(min_out) }] })
    .to_string();
    let args = |v: Value| Base64VecU8::from(v.to_string().into_bytes());
    json!({ "FunctionCall": { "receiver_id": wrap, "actions": [
        { "method_name": "near_deposit", "args": args(json!({})), "deposit": amount, "gas": U64(GAS_NEAR_DEPOSIT.as_gas()) },
        { "method_name": "ft_transfer_call",
          "args": args(json!({ "receiver_id": exchange, "amount": amount, "msg": msg })),
          "deposit": U128(1), "gas": U64(GAS_FT_TRANSFER_CALL.as_gas()) },
    ]}})
}
