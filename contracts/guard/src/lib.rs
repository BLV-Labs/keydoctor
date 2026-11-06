// Key Doctor Guard (docs/final-idea.md §11.5): a Sputnik v2 DAO member with role `agent-guard`. A registered
// agent asks for a NEAR transfer; the Guard always creates the proposal and approves it itself only when the
// request is within its limits. Everything else waits for the council. Only the DAO changes the configuration.
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue, PublicKey,
};

mod dao;
mod events;
mod policy;
mod types;

use dao::{ext_dao, transfer_kind, DaoPolicyView, ProposalView};
use events::emit;
pub use types::*;

// Static gas per hop. Measured on testnet in GĐ15: the whole Auto chain burns about 13 Tgas.
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ON_ADDED: Gas = Gas::from_tgas(120);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(80);
const GAS_ON_VOTED: Gas = Gas::from_tgas(10);
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_ON_VIEW: Gas = Gas::from_tgas(15);
const GAS_ON_AGENT_CREATED: Gas = Gas::from_tgas(5);
// Fixed, so it caps the code size: 30 Tgas stopped at about 340 KB, and the Guard is 262 KB.
const GAS_GET_CODE: Gas = Gas::from_tgas(60);
const GAS_ON_CODE: Gas = Gas::from_tgas(60);
const GAS_MIGRATE: Gas = Gas::from_tgas(20);
// NEAR's limit on one contract's code.
const MAX_CODE_BYTES: usize = 4 * 1024 * 1024;

// §11.10.2. What a Guard-made agent account starts with; its balance is the cap on the gas it can burn.
const AGENT_GAS_FUND: NearToken = NearToken::from_millinear(500);
const AGENT_KEY_METHODS: &str = "request_transfer,sync_request";

// §11.5.10
const MAX_WHITELIST: u32 = 50;
const MAX_AGENTS: u32 = 10;
const MAX_GUARDIANS: u32 = 5;
const MAX_RECENT: u32 = 200;
const MAX_LABEL_CHARS: usize = 64;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    Whitelist,
    Guardians,
    Requests,
    ByProposal,
    Recent,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    dao_id: AccountId,
    policy: GuardPolicy,
    agents: IterableMap<AccountId, AgentInfo>,
    whitelist: IterableMap<AccountId, WhitelistEntry>,
    /// May pause; only the DAO unpauses.
    guardians: IterableSet<AccountId>,
    paused: bool,
    /// ns, start of the rolling 24 h window.
    window_start: u64,
    /// yoctoNEAR self-approved in the window.
    spent_in_window: u128,
    /// Cached from `dao.get_policy` at init and by `refresh_bond`.
    proposal_bond: u128,
    /// ns, cached with the bond; `sync_request` uses it to see that an ignored proposal expired.
    proposal_period: u64,
    requests: LookupMap<String, RequestRecord>,
    by_proposal: LookupMap<u64, String>,
    /// Ring of the last `MAX_RECENT` request ids; slot `recent_total % MAX_RECENT` is the next to overwrite.
    recent: Vector<String>,
    recent_total: u64,
}

#[near]
impl Guard {
    /// One Guard per DAO. Reads the DAO's bond and proposal period right after init (`on_policy_refreshed`).
    #[init]
    pub fn new(
        dao_id: AccountId,
        policy: GuardPolicy,
        agents: Vec<AgentInput>,
        whitelist: Vec<WhitelistInput>,
        guardians: Vec<AccountId>,
    ) -> Self {
        require!(agents.len() <= MAX_AGENTS as usize, "TOO_MANY_AGENTS");
        require!(whitelist.len() <= MAX_WHITELIST as usize, "TOO_MANY_WHITELIST");
        require!(guardians.len() <= MAX_GUARDIANS as usize, "TOO_MANY_GUARDIANS");
        let mut guard = Self {
            dao_id,
            policy,
            agents: IterableMap::new(StorageKey::Agents),
            whitelist: IterableMap::new(StorageKey::Whitelist),
            guardians: IterableSet::new(StorageKey::Guardians),
            paused: false,
            window_start: env::block_timestamp(),
            spent_in_window: 0,
            proposal_bond: 0,
            proposal_period: 0,
            requests: LookupMap::new(StorageKey::Requests),
            by_proposal: LookupMap::new(StorageKey::ByProposal),
            recent: Vector::new(StorageKey::Recent),
            recent_total: 0,
        };
        for a in agents {
            assert_label(&a.label);
            if let Some(key) = a.public_key {
                create_agent_account(&a.account_id, key).detach();
            }
            guard.agents.insert(a.account_id, AgentInfo { label: a.label, enabled: true, creating: false, pending: 0 });
        }
        for w in whitelist {
            assert_label(&w.label);
            guard.whitelist.insert(w.account_id, WhitelistEntry { label: w.label, max_per_tx: w.max_per_tx });
        }
        for g in guardians {
            guard.guardians.insert(g);
        }
        guard.read_dao_policy().detach();
        guard
    }

    /// Called by a registered agent with 0 deposit. Checks 1–7 fail the transaction (§11.5.4); past them the
    /// Guard always creates a proposal, and votes for it only when the decision is Auto.
    pub fn request_transfer(
        &mut self,
        request_id: String,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        require!(!self.paused, "PAUSED");
        let agent = env::predecessor_account_id();
        let (enabled, pending) = match self.agents.get(&agent) {
            Some(a) => (a.enabled && !a.creating, a.pending),
            None => env::panic_str("UNKNOWN_AGENT"),
        };
        require!(enabled, "AGENT_DISABLED");
        require!(policy::valid_request_id(&request_id), "INVALID_REQUEST_ID");
        require!(!self.requests.contains_key(&request_id), "DUPLICATE_REQUEST");
        require!(amount.0 > 0, "INVALID_AMOUNT");
        require!(pending < self.policy.max_pending_per_agent, "TOO_MANY_PENDING");
        require!(
            env::account_balance().as_yoctonear() >= self.proposal_bond.saturating_add(self.reserve()),
            "INSUFFICIENT_GUARD_BALANCE"
        );

        let now = env::block_timestamp();
        self.roll_window(now);
        let (decision, reasons) =
            policy::decide(&self.policy, self.whitelist.get(&receiver_id), self.spent_in_window, amount.0);
        let counted = decision == Decision::Auto;
        if counted {
            self.spent_in_window = self.spent_in_window.saturating_add(amount.0);
        }
        self.agents.get_mut(&agent).unwrap().pending += 1;

        let memo = policy::clean_memo(memo.as_deref().unwrap_or(""));
        let description = policy::description(&request_id, agent.as_str(), decision, &reasons, &memo);
        let record = RequestRecord {
            request_id: request_id.clone(),
            agent,
            receiver_id,
            amount,
            memo,
            decision,
            reasons,
            proposal_id: None,
            status: RequestStatus::Submitted,
            created_at: U64(now),
            updated_at: U64(now),
            counted_in_window: counted,
        };
        let kind = transfer_kind(&record.receiver_id, amount);
        emit("request_submitted", record_event(&record));
        self.requests.insert(request_id.clone(), record);
        self.push_recent(request_id.clone());

        ext_dao::ext(self.dao_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(self.proposal_bond))
            .with_static_gas(GAS_ADD_PROPOSAL)
            .add_proposal(json!({ "description": description, "kind": kind }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_ADDED).on_proposal_added(request_id))
    }

    #[private]
    pub fn on_proposal_added(
        &mut self,
        request_id: String,
        #[callback_result] added: Result<u64, PromiseError>,
    ) -> PromiseOrValue<RequestRecord> {
        let mut r = self.record(&request_id);
        let now = env::block_timestamp();
        let Ok(id) = added else {
            self.finish(&mut r, RequestStatus::Failed, now);
            emit("request_failed", with_note(&r, "add_proposal failed"));
            return PromiseOrValue::Value(self.save(r));
        };
        r.proposal_id = Some(id);
        r.updated_at = U64(now);
        self.by_proposal.insert(id, request_id.clone());
        if r.decision == Decision::Pending {
            self.finish(&mut r, RequestStatus::Pending, now);
            emit("request_pending", record_event(&r));
            return PromiseOrValue::Value(self.save(r));
        }
        let kind = transfer_kind(&r.receiver_id, r.amount);
        self.save(r);
        PromiseOrValue::Promise(
            ext_dao::ext(self.dao_id.clone())
                .with_static_gas(GAS_ACT_PROPOSAL)
                .act_proposal(id, "VoteApprove".to_string(), kind, None)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VOTED).on_voted(request_id)),
        )
    }

    #[private]
    pub fn on_voted(&mut self, request_id: String, #[callback_result] voted: Result<(), PromiseError>) -> RequestRecord {
        let mut r = self.record(&request_id);
        let now = env::block_timestamp();
        if r.status.is_final() {
            // A sync_request between act_proposal and this callback already saw the final DAO status.
            return r;
        }
        if voted.is_err() {
            self.finish(&mut r, RequestStatus::Failed, now);
            emit("request_failed", with_note(&r, "act_proposal failed; the proposal stays InProgress for the council"));
        } else {
            // The final Executed / Failed comes from sync_request.
            self.finish(&mut r, RequestStatus::AutoApproved, now);
            emit("request_auto_approved", record_event(&r));
        }
        self.save(r)
    }

    /// Anyone may call. Reads the proposal from the DAO and records the final status.
    pub fn sync_request(&mut self, request_id: String) -> PromiseOrValue<RequestRecord> {
        let r = self.record(&request_id);
        match r.proposal_id {
            Some(id) if !r.status.is_final() => PromiseOrValue::Promise(
                ext_dao::ext(self.dao_id.clone())
                    .with_static_gas(GAS_VIEW)
                    .get_proposal(id)
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VIEW).on_synced(request_id)),
            ),
            _ => PromiseOrValue::Value(r),
        }
    }

    #[private]
    pub fn on_synced(
        &mut self,
        request_id: String,
        #[callback_result] proposal: Result<ProposalView, PromiseError>,
    ) -> RequestRecord {
        let mut r = self.record(&request_id);
        let now = env::block_timestamp();
        let (next, dao_status) = match proposal {
            Ok(p) => (policy::final_status(&p.status, p.submission_time.0, self.proposal_period, now), p.status),
            // Sputnik deletes a Removed proposal, so get_proposal fails. Only a Pending request may read that as
            // Rejected: for an Auto request a failed read must never refund the daily limit.
            Err(_) if r.status == RequestStatus::Pending => (Some(RequestStatus::Rejected), "Removed".to_string()),
            Err(_) => (None, "Unreadable".to_string()),
        };
        if let Some(status) = next {
            self.finish(&mut r, status, now);
        }
        let mut data = record_event(&r);
        data["dao_status"] = json!(dao_status);
        emit("request_synced", data);
        self.save(r)
    }

    // ---- configuration: DAO only (a FunctionCall proposal). Methods that add data take a storage deposit.

    #[payable]
    pub fn set_policy(&mut self, policy: GuardPolicy) {
        self.assert_dao();
        emit("policy_updated", json!({ "policy": policy }));
        self.policy = policy;
        refund_deposit(0);
    }

    /// With `public_key` the Guard also creates the agent's account, so the deposit covers `AGENT_GAS_FUND` too.
    #[payable]
    pub fn add_agent(&mut self, account_id: AccountId, label: String, public_key: Option<PublicKey>) {
        self.assert_dao();
        assert_label(&label);
        let before = env::storage_usage();
        match self.agents.get_mut(&account_id) {
            Some(a) => {
                require!(public_key.is_none(), "AGENT_EXISTS");
                a.label = label;
            }
            None => {
                require!(self.agents.len() < MAX_AGENTS, "TOO_MANY_AGENTS");
                // The account of a removed agent stays with its key, so that key must never pass as this agent:
                // a Guard subaccount needs a new key, and a keyed agent waits until its account is confirmed.
                require!(public_key.is_some() || !account_id.is_sub_account_of(&env::current_account_id()), "AGENT_KEY_REQUIRED");
                self.agents.insert(account_id.clone(), AgentInfo { label, enabled: true, creating: public_key.is_some(), pending: 0 });
            }
        }
        self.agents.flush();
        let fund = if public_key.is_some() { AGENT_GAS_FUND.as_yoctonear() } else { 0 };
        charge_storage_and(before, fund);
        emit("agent_updated", json!({ "account_id": account_id, "action": "added" }));
        if let Some(key) = public_key {
            create_agent_account(&account_id, key)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_AGENT_CREATED).on_agent_created(account_id))
                .detach();
        }
    }

    /// The account of a removed agent stays, so reusing its name fails here: the agent must not stay registered
    /// with a key its owner does not hold. If this callback never runs, the agent stays unable to request. It
    /// touches only an entry still `creating`, and `remove_agent` waits for it, so that entry is the one it was for.
    #[private]
    pub fn on_agent_created(&mut self, account_id: AccountId, #[callback_result] created: Result<(), PromiseError>) {
        let creating = self.agents.get(&account_id).is_some_and(|a| a.creating);
        if created.is_err() {
            if creating {
                self.agents.remove(&account_id);
            }
            Promise::new(self.dao_id.clone()).transfer(AGENT_GAS_FUND).detach();
            emit("agent_updated", json!({ "account_id": account_id, "action": "create_failed" }));
        } else if creating {
            let a = self.agents.get_mut(&account_id).unwrap_or_else(|| env::panic_str("UNKNOWN_AGENT"));
            a.creating = false;
            emit("agent_updated", json!({ "account_id": account_id, "action": "created" }));
        }
    }

    #[payable]
    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.assert_dao();
        // Removing and re-adding in these few blocks would let the first callback confirm the second entry, whose
        // key never reaches the account: the removed key would pass as the new agent. A `creating` agent cannot request.
        require!(!self.agents.get(&account_id).is_some_and(|a| a.creating), "AGENT_CREATING");
        self.agents.remove(&account_id);
        emit("agent_updated", json!({ "account_id": account_id, "action": "removed" }));
        refund_deposit(0);
    }

    #[payable]
    pub fn set_agent_enabled(&mut self, account_id: AccountId, enabled: bool) {
        self.assert_dao();
        let a = self.agents.get_mut(&account_id).unwrap_or_else(|| env::panic_str("UNKNOWN_AGENT"));
        a.enabled = enabled;
        emit("agent_updated", json!({ "account_id": account_id, "action": "enabled", "enabled": enabled }));
        refund_deposit(0);
    }

    #[payable]
    pub fn add_whitelist(&mut self, account_id: AccountId, label: String, max_per_tx: Option<U128>) {
        self.assert_dao();
        assert_label(&label);
        let before = env::storage_usage();
        if !self.whitelist.contains_key(&account_id) {
            require!(self.whitelist.len() < MAX_WHITELIST, "TOO_MANY_WHITELIST");
        }
        self.whitelist.insert(account_id.clone(), WhitelistEntry { label, max_per_tx });
        self.whitelist.flush();
        charge_storage(before);
        emit("whitelist_updated", json!({ "account_id": account_id, "action": "added", "max_per_tx": max_per_tx }));
    }

    #[payable]
    pub fn remove_whitelist(&mut self, account_id: AccountId) {
        self.assert_dao();
        self.whitelist.remove(&account_id);
        emit("whitelist_updated", json!({ "account_id": account_id, "action": "removed" }));
        refund_deposit(0);
    }

    #[payable]
    pub fn add_guardian(&mut self, account_id: AccountId) {
        self.assert_dao();
        let before = env::storage_usage();
        if !self.guardians.contains(&account_id) {
            require!(self.guardians.len() < MAX_GUARDIANS, "TOO_MANY_GUARDIANS");
            self.guardians.insert(account_id);
        }
        self.guardians.flush();
        charge_storage(before);
    }

    #[payable]
    pub fn remove_guardian(&mut self, account_id: AccountId) {
        self.assert_dao();
        self.guardians.remove(&account_id);
        refund_deposit(0);
    }

    /// Guardian or DAO. Takes effect at once.
    pub fn pause(&mut self) {
        let caller = env::predecessor_account_id();
        require!(caller == self.dao_id || self.guardians.contains(&caller), "NOT_GUARDIAN");
        self.paused = true;
        emit("paused", json!({ "by": caller }));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_dao();
        self.paused = false;
        emit("unpaused", json!({ "by": self.dao_id }));
        refund_deposit(0);
    }

    /// Re-reads `proposal_bond` (and `proposal_period`) from `dao.get_policy`.
    #[payable]
    pub fn refresh_bond(&mut self) -> Promise {
        self.assert_dao();
        refund_deposit(0);
        self.read_dao_policy()
    }

    #[private]
    pub fn on_policy_refreshed(&mut self, #[callback_result] p: Result<DaoPolicyView, PromiseError>) {
        let p = p.unwrap_or_else(|_| env::panic_str("GET_POLICY_FAILED"));
        self.proposal_bond = p.proposal_bond.0;
        self.proposal_period = p.proposal_period.0;
        emit("policy_updated", json!({ "proposal_bond": p.proposal_bond, "proposal_period": p.proposal_period }));
    }

    /// Sends everything above what the Guard must keep (its storage, or `min_reserve` if higher) back to the DAO.
    #[payable]
    pub fn withdraw_excess(&mut self) -> Promise {
        self.assert_dao();
        let excess = env::account_balance().as_yoctonear().saturating_sub(self.reserve());
        require!(excess > 0, "NOTHING_TO_WITHDRAW");
        Promise::new(self.dao_id.clone()).transfer(NearToken::from_yoctonear(excess))
    }

    // ---- views

    pub fn get_config(&self) -> Value {
        json!({
            "dao_id": self.dao_id,
            "paused": self.paused,
            "proposal_bond": U128(self.proposal_bond),
            "proposal_period": U64(self.proposal_period),
            "agents": self.agents.len(),
            "whitelist": self.whitelist.len(),
            "guardians": self.guardians.iter().collect::<Vec<_>>(),
        })
    }

    pub fn get_policy(&self) -> GuardPolicy {
        self.policy.clone()
    }

    pub fn get_whitelist(&self) -> Vec<Value> {
        self.whitelist
            .iter()
            .map(|(id, w)| json!({ "account_id": id, "label": w.label, "max_per_tx": w.max_per_tx }))
            .collect()
    }

    pub fn get_agents(&self) -> Vec<Value> {
        self.agents
            .iter()
            .map(|(id, a)| json!({ "account_id": id, "label": a.label, "enabled": a.enabled && !a.creating, "pending": a.pending }))
            .collect()
    }

    /// The window as the next request would see it (a window past 24 h reads as already reset).
    pub fn get_window(&self) -> Value {
        let now = env::block_timestamp();
        let (start, spent) = policy::roll_window(self.window_start, self.spent_in_window, now);
        json!({
            "window_start": U64(start),
            "resets_at": U64(start.saturating_add(policy::DAY_NS)),
            "spent_in_window": U128(spent),
            "remaining": U128(self.policy.max_per_day.0.saturating_sub(spent)),
        })
    }

    pub fn get_request(&self, request_id: String) -> Option<RequestRecord> {
        self.requests.get(&request_id).cloned()
    }

    pub fn get_request_by_proposal(&self, proposal_id: u64) -> Option<RequestRecord> {
        self.by_proposal.get(&proposal_id).and_then(|id| self.requests.get(id)).cloned()
    }

    /// Newest first, from the last `MAX_RECENT` requests. `from` skips that many; `limit` is at most 50.
    pub fn list_requests(&self, from: Option<u32>, limit: Option<u32>) -> Vec<RequestRecord> {
        let from = from.unwrap_or(0) as u64;
        let limit = limit.unwrap_or(20).min(50) as u64;
        let len = self.recent.len() as u64;
        (from..len.min(from.saturating_add(limit)))
            .filter_map(|k| {
                let slot = ((self.recent_total - 1 - k) % MAX_RECENT as u64) as u32;
                self.recent.get(slot).and_then(|id| self.requests.get(id)).cloned()
            })
            .collect()
    }

    /// Key Doctor reads this to recognise a DAO member as a Guard (§5.3).
    pub fn kd_guard_info(&self) -> Value {
        json!({ "standard": "kd_guard", "version": "1.1.0", "dao_id": self.dao_id })
    }

    // ---- upgrade (§11.5.12, ADR 0006)

    /// Fetches the code from `code_source` and deploys it only if it hashes to `code_hash`, so the source needs no
    /// trust: the DAO votes on the hash. Not a DAO `UpgradeRemote`: the installed Sputnik runs out of gas on any
    /// wasm over about 150 KB (B-Q10). The Guard has no key, so this is the only way its code changes.
    pub fn upgrade(&self, code_source: AccountId, code_hash: Base58CryptoHash) -> Promise {
        self.assert_dao();
        Promise::new(code_source).function_call("get_guard_code", Vec::new(), NearToken::from_near(0), GAS_GET_CODE).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CODE).on_code(code_hash),
        )
    }

    /// Deploy and `migrate` share one receipt: if `migrate` fails, the old code stays.
    #[private]
    pub fn on_code(&self, code_hash: Base58CryptoHash) -> Promise {
        let code = env::promise_result_checked(0, MAX_CODE_BYTES).unwrap_or_else(|_| env::panic_str("CODE_UNAVAILABLE"));
        require!(env::sha256_array(&code) == CryptoHash::from(code_hash), "CODE_HASH_MISMATCH");
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate",
            Vec::new(),
            NearToken::from_near(0),
            GAS_MIGRATE,
        )
    }

    /// Reads the state the previous code wrote. A release that changes `Guard` reads the old layout here.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("NO_STATE"))
    }
}

impl Guard {
    fn assert_dao(&self) {
        require!(env::predecessor_account_id() == self.dao_id, "ONLY_DAO");
    }

    fn read_dao_policy(&self) -> Promise {
        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_VIEW)
            .get_policy()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VIEW).on_policy_refreshed())
    }

    fn record(&self, request_id: &String) -> RequestRecord {
        self.requests.get(request_id).cloned().unwrap_or_else(|| env::panic_str("UNKNOWN_REQUEST"))
    }

    fn save(&mut self, r: RequestRecord) -> RequestRecord {
        self.requests.insert(r.request_id.clone(), r.clone());
        r
    }

    fn roll_window(&mut self, now: u64) {
        (self.window_start, self.spent_in_window) = policy::roll_window(self.window_start, self.spent_in_window, now);
    }

    /// Moves a request to `status`: frees the agent's pending slot when the request stops waiting on the DAO, and
    /// gives the daily limit back when counted money did not leave, if the request is still in the same window.
    fn finish(&mut self, r: &mut RequestRecord, status: RequestStatus, now: u64) {
        if r.status.holds_pending() && !status.holds_pending() {
            if let Some(a) = self.agents.get_mut(&r.agent) {
                a.pending = a.pending.saturating_sub(1);
            }
        }
        if status.is_final() && status != RequestStatus::Executed && r.counted_in_window {
            self.roll_window(now);
            if r.created_at.0 >= self.window_start {
                self.spent_in_window = self.spent_in_window.saturating_sub(r.amount.0);
                r.counted_in_window = false;
            }
        }
        r.status = status;
        r.updated_at = U64(now);
    }

    /// What the Guard must keep: its storage cost, or `min_reserve` when higher. Each request record adds storage
    /// the Guard pays for, so once records outgrow `min_reserve` requests stop instead of failing mid-flow.
    fn reserve(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        storage.max(self.policy.min_reserve.0)
    }

    fn push_recent(&mut self, request_id: String) {
        if self.recent.len() < MAX_RECENT {
            self.recent.push(request_id);
        } else {
            self.recent.set((self.recent_total % MAX_RECENT as u64) as u32, request_id);
        }
        self.recent_total += 1;
    }
}

fn assert_label(label: &str) {
    require!(label.chars().count() <= MAX_LABEL_CHARS, "LABEL_TOO_LONG");
}

/// Requires the attached deposit to cover the storage added since `before`, and returns the rest.
/// The only place that gives an agent account a key, so the key's receiver and methods never come from outside.
fn create_agent_account(account_id: &AccountId, public_key: PublicKey) -> Promise {
    let guard = env::current_account_id();
    require!(account_id.is_sub_account_of(&guard), "AGENT_NOT_SUBACCOUNT");
    Promise::new(account_id.clone()).create_account().transfer(AGENT_GAS_FUND).add_access_key_allowance(
        public_key,
        Allowance::Unlimited,
        guard,
        AGENT_KEY_METHODS,
    )
}

fn charge_storage(before: u64) {
    charge_storage_and(before, 0);
}

fn charge_storage_and(before: u64, extra: u128) {
    let added = env::storage_usage().saturating_sub(before) as u128;
    let cost = env::storage_byte_cost().as_yoctonear() * added + extra;
    require!(env::attached_deposit().as_yoctonear() >= cost, "INSUFFICIENT_STORAGE_DEPOSIT");
    refund_deposit(cost);
}

fn refund_deposit(cost: u128) {
    let rest = env::attached_deposit().as_yoctonear().saturating_sub(cost);
    if rest > 0 {
        Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(rest)).detach();
    }
}

fn record_event(r: &RequestRecord) -> Value {
    json!({
        "request_id": r.request_id,
        "proposal_id": r.proposal_id,
        "agent": r.agent,
        "receiver_id": r.receiver_id,
        "amount": r.amount,
        "decision": r.decision,
        "reasons": r.reasons,
        "status": r.status,
    })
}

fn with_note(r: &RequestRecord, note: &str) -> Value {
    let mut data = record_event(r);
    data["note"] = json!(note);
    data
}

#[cfg(test)]
mod tests;
