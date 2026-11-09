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

use dao::{
    ext_dao, ext_exchange, function_call_kind, swap_kind, transfer_kind, DaoPolicyView, ProposalView,
};
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
// Fixed, so it caps the code size: 30 Tgas stopped at about 340 KB, and the Guard is 333 KB.
// Swap step (Change 1.4): each hop holds what the hops after it attach, with F = GAS_FT_TRANSFER_CALL.
// act_proposal 15 own + near_deposit + F; on_proposal_added 5 + act + on_voted; on_quote 5 + add_proposal + on_added;
// execute_plan_step 10 + get_return + on_quote = 80 + F, inside the keeper's 300 Tgas.
const GAS_QUOTE_VIEW: Gas = Gas::from_tgas(10);
const GAS_ACT_PROPOSAL_SWAP: Gas = Gas::from_tgas(20 + 150);
const GAS_ON_ADDED_SWAP: Gas = Gas::from_tgas(35 + 150);
const GAS_ON_QUOTE: Gas = Gas::from_tgas(60 + 150);
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
    Plans,
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
    /// `plan_id` is the index. A plan is never removed, so a request can always find its plan.
    plans: Vector<Plan>,
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
            plans: Vector::new(StorageKey::Plans),
        };
        for a in agents {
            assert_label(&a.label);
            if let Some(key) = a.public_key {
                create_agent_account(&a.account_id, key).detach();
            }
            guard.agents.insert(a.account_id, AgentInfo { label: a.label, enabled: true, creating: false, pending: 0, spent: U128(0), spent_window: U64(0) });
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
        let window = self.window_start;
        let a = self.agents.get_mut(&agent).unwrap();
        a.pending += 1;
        if counted {
            let so_far = if a.spent_window.0 == window { a.spent.0 } else { 0 };
            a.spent = U128(so_far.saturating_add(amount.0));
            a.spent_window = U64(window);
            self.spent_in_window = self.spent_in_window.saturating_add(amount.0);
        }

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
            plan_id: None,
        };
        let kind = transfer_kind(&record.receiver_id, amount);
        emit("request_submitted", record_event(&record));
        self.requests.insert(request_id.clone(), record);
        self.push_recent(request_id.clone());

        ext_dao::ext(self.dao_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(self.proposal_bond))
            .with_static_gas(GAS_ADD_PROPOSAL)
            .add_proposal(json!({ "description": description, "kind": kind }))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_ADDED).on_proposal_added(request_id, None))
    }

    #[private]
    pub fn on_proposal_added(
        &mut self,
        request_id: String,
        // Set by a swap step, whose `min_amount_out` is known only at run time. Unset: rebuild from the plan, which
        // is also what a callback already in flight at an upgrade carries.
        kind: Option<Value>,
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
        let swap = kind.is_some();
        let kind = match (kind, r.plan_id) {
            (Some(kind), _) => kind,
            (None, Some(plan_id)) => plan_kind(&self.plan(plan_id)),
            (None, None) => transfer_kind(&r.receiver_id, r.amount),
        };
        self.save(r);
        PromiseOrValue::Promise(
            ext_dao::ext(self.dao_id.clone())
                .with_static_gas(if swap { GAS_ACT_PROPOSAL_SWAP } else { GAS_ACT_PROPOSAL })
                .act_proposal(id, "VoteApprove".to_string(), kind, None)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VOTED).on_voted(request_id)),
        )
    }

    /// Step 4c, second hop. A failed or empty quote pauses the plan with `QUOTE_FAILED` before the request fails,
    /// because `finish` would otherwise pause it with `ADD_PROPOSAL_FAILED`; `finish` also gives the daily limit back.
    #[private]
    pub fn on_quote(
        &mut self,
        request_id: String,
        plan_id: u32,
        #[callback_result] quote: Result<U128, PromiseError>,
    ) -> PromiseOrValue<RequestRecord> {
        let mut r = self.record(&request_id);
        let now = env::block_timestamp();
        let mut plan = self.plan(plan_id);
        let PlanAction::Swap { pool_id: _, ref token_out, max_slippage_bps } = plan.action else {
            env::panic_str("NOT_A_SWAP_PLAN");
        };
        let quote = quote.map(|q| q.0).unwrap_or(0);
        if quote == 0 {
            self.halt_plan(&mut plan, PlanPauseReason::Failures, "QUOTE_FAILED");
            self.plans.set(plan_id, plan);
            self.finish(&mut r, RequestStatus::Failed, now);
            emit("request_failed", with_note(&r, "swap quote failed"));
            return PromiseOrValue::Value(self.save(r));
        }
        // quote * (10000 - bps) / 10000 without the overflow of the product.
        let keep = 10_000 - max_slippage_bps as u128;
        let min_out = quote / 10_000 * keep + quote % 10_000 * keep / 10_000;
        let guard = env::current_account_id();
        let (wrap, exchange) = policy::dex_for(&guard).unwrap_or_else(|| env::panic_str("SWAP_NOT_SUPPORTED"));
        let PlanAction::Swap { pool_id, .. } = plan.action else { unreachable!() };
        let kind = swap_kind(wrap, exchange, plan.amount_per_run, pool_id, token_out, min_out);
        let description = policy::description(&request_id, guard.as_str(), Decision::Auto, &[], &r.memo);
        PromiseOrValue::Promise(
            ext_dao::ext(self.dao_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(self.proposal_bond))
                .with_static_gas(GAS_ADD_PROPOSAL)
                .add_proposal(json!({ "description": description, "kind": kind }))
                .then(Self::ext(guard).with_static_gas(GAS_ON_ADDED_SWAP).on_proposal_added(request_id, Some(kind))),
        )
    }

    #[private]
    pub fn on_voted(&mut self, request_id: String) -> RequestRecord {
        // act_proposal returns what the executed proposal returns: nothing for a transfer, the
        // ft_transfer_call amount for a swap (ADR 0007). Only success matters, so the bytes are not read;
        // TooLong means it succeeded with a non-empty value.
        let voted = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        self.record_vote(request_id, voted)
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

    // ---- plans (§11.11): the DAO writes them, anyone runs the step that is due (ADR 0005, K2).

    /// Refused when a run could never pass the limits as they stand, so a plan cannot start out over them.
    #[payable]
    pub fn create_plan(&mut self, plan: PlanInput) -> u32 {
        self.assert_dao();
        let guard = env::current_account_id();
        let factory = guard.get_parent_account_id().map(|f| f.as_str().to_string());
        if let Err(code) = policy::check_plan(&plan, &guard, &self.dao_id, factory.as_deref()) {
            env::panic_str(code);
        }
        if let Some(reason) = self.plan_limit_failure(&plan.action, plan.amount_per_run.0) {
            env::panic_str(&reason);
        }
        let before = env::storage_usage();
        let plan_id = self.plans.len();
        let plan = Plan {
            plan_id,
            action: plan.action,
            strategy_id: plan.strategy_id,
            token_in: plan.token_in,
            amount_per_run: plan.amount_per_run,
            interval_sec: plan.interval_sec,
            runs_total: plan.runs_total,
            runs_done: 0,
            start_at: plan.start_at,
            next_run_at: Some(plan.start_at),
            status: PlanStatus::Active,
            pause_reason: None,
        };
        emit("plan_created", json!({ "plan": plan }));
        self.plans.push(plan);
        self.plans.flush();
        charge_storage(before);
        plan_id
    }

    #[payable]
    pub fn pause_plan(&mut self, plan_id: u32) {
        self.assert_dao();
        let mut plan = self.plan(plan_id);
        require!(plan.status == PlanStatus::Active, "PLAN_NOT_ACTIVE");
        self.halt_plan(&mut plan, PlanPauseReason::Owner, "owner");
        self.plans.set(plan_id, plan);
        refund_deposit(0);
    }

    /// A step that came due while paused runs at the next call, once.
    #[payable]
    pub fn resume_plan(&mut self, plan_id: u32) {
        self.assert_dao();
        let mut plan = self.plan(plan_id);
        require!(plan.status == PlanStatus::Paused, "PLAN_NOT_PAUSED");
        plan.status = PlanStatus::Active;
        plan.pause_reason = None;
        emit("plan_resumed", json!({ "plan_id": plan_id }));
        self.plans.set(plan_id, plan);
        refund_deposit(0);
    }

    #[payable]
    pub fn cancel_plan(&mut self, plan_id: u32) {
        self.assert_dao();
        let mut plan = self.plan(plan_id);
        require!(matches!(plan.status, PlanStatus::Active | PlanStatus::Paused), "PLAN_ENDED");
        plan.status = PlanStatus::Cancelled;
        plan.pause_reason = None;
        plan.next_run_at = None;
        emit("plan_cancelled", json!({ "plan_id": plan_id }));
        self.plans.set(plan_id, plan);
        refund_deposit(0);
    }

    /// Anyone may call, with no deposit: the caller only pays gas and passes nothing but the id. A skip or a pause
    /// is a normal result, not a failed transaction, so that it is saved; it returns `null`, and a run returns the
    /// step's request. The slot moves on in this first receipt, which is what stops a second call from running the
    /// same step. All promise gas is static, so too little gas fails here and leaves the plan as it was.
    pub fn execute_plan_step(&mut self, plan_id: u32) -> PromiseOrValue<Option<RequestRecord>> {
        require!(!self.paused, "PAUSED");
        let mut plan = self.plan(plan_id);
        require!(plan.status == PlanStatus::Active, "PLAN_NOT_ACTIVE");
        let now = env::block_timestamp();
        let due = plan.next_run_at.unwrap_or_else(|| env::panic_str("PLAN_NOT_ACTIVE")).0;
        require!(now >= due, "PLAN_NOT_DUE");
        let run = plan.runs_done + 1;
        let amount = plan.amount_per_run;
        self.roll_window(now);

        // The rules changed since `create_plan`, and only the owner can settle that.
        if let Some(reason) = self.plan_limit_failure(&plan.action, amount.0) {
            self.halt_plan(&mut plan, PlanPauseReason::Failures, &reason);
            self.plans.set(plan_id, plan);
            return PromiseOrValue::Value(None);
        }
        if self.spent_in_window.saturating_add(amount.0) > self.policy.max_per_day.0 {
            plan.next_run_at = Some(U64(policy::next_run(due, plan.interval_sec, now)));
            emit("plan_step_skipped", json!({ "plan_id": plan_id, "run": run, "reason": "OVER_DAILY_LIMIT", "due": U64(due) }));
            self.plans.set(plan_id, plan);
            return PromiseOrValue::Value(None);
        }
        if env::account_balance().as_yoctonear() < self.proposal_bond.saturating_add(self.reserve()) {
            self.halt_plan(&mut plan, PlanPauseReason::GuardLowNear, "INSUFFICIENT_GUARD_BALANCE");
            self.plans.set(plan_id, plan);
            return PromiseOrValue::Value(None);
        }

        plan.next_run_at = Some(U64(policy::next_run(due, plan.interval_sec, now)));
        self.spent_in_window = self.spent_in_window.saturating_add(amount.0);
        let guard = env::current_account_id();
        // The slot, not the run: a run that failed is tried again under a new id, and its old record stays.
        let request_id = format!("{}{plan_id}-{due}", policy::PLAN_REQUEST_PREFIX);
        let memo = format!("plan {plan_id} run {run}");
        let description = policy::description(&request_id, guard.as_str(), Decision::Auto, &[], &memo);
        let receiver_id = match &plan.action {
            PlanAction::Transfer { receiver_id } => receiver_id.clone(),
            PlanAction::Call { target, .. } => target.clone(),
            PlanAction::Swap { .. } => {
                let (wrap, _) = policy::dex_for(&guard).unwrap_or_else(|| env::panic_str("SWAP_NOT_SUPPORTED"));
                wrap.parse().unwrap_or_else(|_| env::panic_str("SWAP_NOT_SUPPORTED"))
            }
        };
        let record = RequestRecord {
            request_id: request_id.clone(),
            agent: guard.clone(),
            receiver_id,
            amount,
            memo,
            decision: Decision::Auto,
            reasons: vec![],
            proposal_id: None,
            status: RequestStatus::Submitted,
            created_at: U64(now),
            updated_at: U64(now),
            counted_in_window: true,
            plan_id: Some(plan_id),
        };
        emit("request_submitted", record_event(&record));
        self.requests.insert(request_id.clone(), record);
        self.push_recent(request_id.clone());
        let swap = match &plan.action {
            PlanAction::Swap { pool_id, token_out, .. } => Some((*pool_id, token_out.clone())),
            _ => None,
        };
        // A swap has no proposal kind yet: it needs the quote first (`on_quote`).
        let kind = swap.is_none().then(|| plan_kind(&plan));
        self.plans.set(plan_id, plan);

        if let Some((pool_id, token_out)) = swap {
            let (wrap, exchange) = policy::dex_for(&guard).unwrap_or_else(|| env::panic_str("SWAP_NOT_SUPPORTED"));
            let (wrap, exchange): (AccountId, AccountId) = (wrap.parse().unwrap(), exchange.parse().unwrap());
            return PromiseOrValue::Promise(
                ext_exchange::ext(exchange)
                    .with_static_gas(GAS_QUOTE_VIEW)
                    .get_return(pool_id, wrap, amount, token_out)
                    .then(Self::ext(guard).with_static_gas(GAS_ON_QUOTE).on_quote(request_id, plan_id)),
            );
        }

        PromiseOrValue::Promise(
            ext_dao::ext(self.dao_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(self.proposal_bond))
                .with_static_gas(GAS_ADD_PROPOSAL)
                .add_proposal(json!({ "description": description, "kind": kind }))
                .then(Self::ext(guard).with_static_gas(GAS_ON_ADDED).on_proposal_added(request_id, None)),
        )
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
                let creating = public_key.is_some();
                self.agents.insert(account_id.clone(), AgentInfo { label, enabled: true, creating, pending: 0, spent: U128(0), spent_window: U64(0) });
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

    /// `spent_24h` is the agent's part of `get_window`'s `spent_in_window`, so it resets with that window.
    pub fn get_agents(&self) -> Vec<Value> {
        let (window, _) = policy::roll_window(self.window_start, self.spent_in_window, env::block_timestamp());
        self.agents
            .iter()
            .map(|(id, a)| {
                let spent = if a.spent_window.0 == window { a.spent } else { U128(0) };
                json!({ "account_id": id, "label": a.label, "enabled": a.enabled && !a.creating, "pending": a.pending, "spent_24h": spent })
            })
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

    pub fn get_plan(&self, plan_id: u32) -> Option<Plan> {
        self.plans.get(plan_id).cloned()
    }

    /// In `plan_id` order. `from` is the first id; `limit` is at most 50.
    pub fn get_plans(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Plan> {
        self.plans.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(20).min(50) as usize).cloned().collect()
    }

    /// Key Doctor reads this to recognise a DAO member as a Guard (§5.3).
    pub fn kd_guard_info(&self) -> Value {
        json!({ "standard": "kd_guard", "version": "1.3.0", "dao_id": self.dao_id })
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
    /// The body of `on_voted`, split out so tests can pass the vote's outcome.
    pub(crate) fn record_vote(&mut self, request_id: String, voted: bool) -> RequestRecord {
        let mut r = self.record(&request_id);
        let now = env::block_timestamp();
        if r.status.is_final() {
            // A sync_request between act_proposal and this callback already saw the final DAO status.
            return r;
        }
        if !voted {
            self.finish(&mut r, RequestStatus::Failed, now);
            emit("request_failed", with_note(&r, "act_proposal failed; the proposal stays InProgress for the council"));
        } else {
            // The final Executed / Failed comes from sync_request.
            self.finish(&mut r, RequestStatus::AutoApproved, now);
            emit("request_auto_approved", record_event(&r));
        }
        self.save(r)
    }

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

    fn plan(&self, plan_id: u32) -> Plan {
        self.plans.get(plan_id).cloned().unwrap_or_else(|| env::panic_str("UNKNOWN_PLAN"))
    }

    /// The first limit a run of this size breaks even in an empty window, so waiting for the window will not help.
    fn plan_limit_failure(&self, action: &PlanAction, amount: u128) -> Option<String> {
        let wl = match action {
            PlanAction::Transfer { receiver_id } => self.whitelist.get(receiver_id),
            PlanAction::Call { .. } | PlanAction::Swap { .. } => None,
        };
        policy::plan_reasons(&self.policy, action, wl, 0, amount).into_iter().next()
    }

    /// Reopens a completed plan when its last run turns out to have failed. A plan the owner paused or cancelled
    /// stays as the owner left it.
    fn halt_plan(&self, plan: &mut Plan, reason: PlanPauseReason, code: &str) {
        if !matches!(plan.status, PlanStatus::Active | PlanStatus::Completed) {
            return;
        }
        plan.status = PlanStatus::Paused;
        plan.pause_reason = Some(reason);
        plan.next_run_at = plan.next_run_at.or(Some(U64(env::block_timestamp())));
        emit("plan_paused", json!({ "plan_id": plan.plan_id, "reason": reason, "code": code }));
    }

    /// Keeps `runs_done` true to the moves of a step's request. `r` still holds the old status. Only the Guard's
    /// vote counts a run; a DAO short of NEAR shows as a failed vote, because the payment fails with it.
    fn move_plan(&mut self, r: &RequestRecord, plan_id: u32, status: RequestStatus) {
        if r.status.is_final() {
            return;
        }
        let approved = |s| matches!(s, RequestStatus::AutoApproved | RequestStatus::Executed);
        let mut plan = self.plan(plan_id);
        match (approved(r.status), approved(status)) {
            (false, true) => {
                plan.runs_done += 1;
                emit("plan_step_executed", json!({ "plan_id": plan_id, "run": plan.runs_done, "request_id": r.request_id, "proposal_id": r.proposal_id }));
                if plan.runs_done >= plan.runs_total && plan.status != PlanStatus::Cancelled {
                    plan.status = PlanStatus::Completed;
                    plan.pause_reason = None;
                    plan.next_run_at = None;
                    emit("plan_completed", json!({ "plan_id": plan_id, "runs": plan.runs_done }));
                }
            }
            (true, false) => {
                plan.runs_done = plan.runs_done.saturating_sub(1);
                self.halt_plan(&mut plan, PlanPauseReason::Failures, "PROPOSAL_FAILED");
            }
            (false, false) if status.is_final() && r.proposal_id.is_none() => {
                self.halt_plan(&mut plan, PlanPauseReason::Failures, "ADD_PROPOSAL_FAILED");
            }
            (false, false) if status.is_final() => {
                // A failed callback carries no cause. A `call` can also fail for a role without `call:VoteApprove`,
                // and a top-up would not help that.
                let reason = match plan.action {
                    PlanAction::Transfer { .. } | PlanAction::Swap { .. } => PlanPauseReason::InsufficientBalance,
                    PlanAction::Call { .. } => PlanPauseReason::Failures,
                };
                self.halt_plan(&mut plan, reason, "VOTE_FAILED");
            }
            _ => return,
        }
        self.plans.set(plan_id, plan);
    }

    /// Moves a request to `status`: frees the agent's pending slot when the request stops waiting on the DAO, and
    /// gives the daily limit back when counted money did not leave, if the request is still in the same window.
    fn finish(&mut self, r: &mut RequestRecord, status: RequestStatus, now: u64) {
        if let Some(plan_id) = r.plan_id {
            self.move_plan(r, plan_id, status);
        }
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
                // `created_at` is in this window, so the agent's amount is too; a re-added agent has none to lose.
                if let Some(a) = self.agents.get_mut(&r.agent) {
                    a.spent = U128(a.spent.0.saturating_sub(r.amount.0));
                }
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

fn plan_kind(plan: &Plan) -> Value {
    match &plan.action {
        PlanAction::Transfer { receiver_id } => transfer_kind(receiver_id, plan.amount_per_run),
        PlanAction::Call { target, method, args_base64, deposit, gas } => {
            function_call_kind(target, method, args_base64, *deposit, *gas)
        }
        // The swap kind needs the run-time quote, so `on_quote` builds it.
        PlanAction::Swap { .. } => env::panic_str("SWAP_KIND_AT_RUN_TIME"),
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
