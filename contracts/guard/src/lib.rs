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
// act_proposal 15 own + near_deposit + F; on_proposal_added 15 + act + on_voted; on_quote 15 + add_proposal + on_added;
// execute_plan_step 10 + get_return + on_quote = 100 + F, inside the keeper's 300 Tgas. The two Guard callbacks keep
// 15 Tgas of their own (red team M3, 1.6.0): with 5, a caller who attached just the static sum could run one out of
// gas after the step had moved its slot, and the request would sit in Submitted with no callback to end it.
const GAS_QUOTE_VIEW: Gas = Gas::from_tgas(10);
const GAS_ACT_PROPOSAL_SWAP: Gas = Gas::from_tgas(20 + 150);
const GAS_ON_ADDED_SWAP: Gas = Gas::from_tgas(45 + 150);
const GAS_ON_QUOTE: Gas = Gas::from_tgas(80 + 150);
// What a swap step must be called with: the 100 + F above plus room the callbacks share as unused-gas weight.
const MIN_SWAP_STEP_GAS: Gas = Gas::from_tgas(280);
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
    AgentSpends,
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
    /// 1.5.0's fixed window, zero since 1.6.0 (`spends` replaced it). Kept so that a 1.5.0 state is this layout
    /// without its last two fields, which is how `migrate` tells the two apart.
    window_start: u64,
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
    /// yoctoNEAR self-approved per hour: the rolling 24 h window (`policy::Spends`, red-team M4).
    spends: policy::Spends,
    /// Each agent's part of `spends`, for `get_agents`. A removed agent's entry goes with it.
    agent_spends: LookupMap<AccountId, policy::Spends>,
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
            window_start: 0,
            spent_in_window: 0,
            proposal_bond: 0,
            proposal_period: 0,
            requests: LookupMap::new(StorageKey::Requests),
            by_proposal: LookupMap::new(StorageKey::ByProposal),
            recent: Vector::new(StorageKey::Recent),
            recent_total: 0,
            plans: Vector::new(StorageKey::Plans),
            spends: policy::Spends::new(),
            agent_spends: LookupMap::new(StorageKey::AgentSpends),
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
        let spent = policy::spent(&self.spends, now);
        let (decision, reasons) = policy::decide(&self.policy, self.whitelist.get(&receiver_id), spent, amount.0);
        let counted = decision == Decision::Auto;
        self.agents.get_mut(&agent).unwrap().pending += 1;
        if counted {
            policy::add_spend(&mut self.spends, now, amount.0);
            policy::add_spend(self.agent_spends.entry(agent.clone()).or_default(), now, amount.0);
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
    /// A quote under the DAO's floor skips the run instead (ADR 0007, 2026-11-12): the caller may have skewed the pool,
    /// so no proposal is made, the slot stays moved on and the daily limit is given back.
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
        let (pool_id, token_out, max_slippage_bps, min_out_per_near) = match &plan.action {
            PlanAction::SwapWithFloor { pool_id, token_out, max_slippage_bps, min_out_per_near } => {
                (*pool_id, token_out.clone(), *max_slippage_bps, min_out_per_near.0)
            }
            // A step of a plan with no floor that was in flight at the upgrade: it must not swap either.
            PlanAction::Swap { .. } => {
                self.halt_plan(&mut plan, PlanPauseReason::PriceFloorRequired, "PRICE_FLOOR_REQUIRED");
                self.plans.set(plan_id, plan);
                self.finish(&mut r, RequestStatus::Failed, now);
                emit("request_failed", with_note(&r, "swap plan has no price floor"));
                return PromiseOrValue::Value(self.save(r));
            }
            _ => env::panic_str("NOT_A_SWAP_PLAN"),
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
        let quote_floor = quote / 10_000 * keep + quote % 10_000 * keep / 10_000;
        let min_out = match policy::dao_floor(plan.amount_per_run.0, min_out_per_near) {
            Some(floor) if quote_floor >= floor => quote_floor.max(floor),
            // Below the floor, or a floor no swap can reach.
            _ => {
                // Not `finish`: its plan move would pause the plan with `ADD_PROPOSAL_FAILED`. A skip is no failure.
                self.settle(&mut r, RequestStatus::Failed, now);
                emit("request_failed", with_note(&r, "swap price below the DAO floor"));
                let due = request_id.rsplit('-').next().and_then(|d| d.parse::<u64>().ok()).unwrap_or_default();
                emit("plan_step_skipped", json!({ "plan_id": plan_id, "run": plan.runs_done + 1, "reason": "PRICE_BELOW_FLOOR", "due": U64(due) }));
                return PromiseOrValue::Value(self.save(r));
            }
        };
        let guard = env::current_account_id();
        let (wrap, exchange) = policy::dex_for(&guard).unwrap_or_else(|| env::panic_str("SWAP_NOT_SUPPORTED"));
        let kind = swap_kind(wrap, exchange, plan.amount_per_run, pool_id, &token_out, min_out);
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

        // A plan made before the price floor (ADR 0007, 2026-11-12) never swaps again; the DAO makes it anew.
        if matches!(plan.action, PlanAction::Swap { .. }) {
            self.halt_plan(&mut plan, PlanPauseReason::PriceFloorRequired, "PRICE_FLOOR_REQUIRED");
            self.plans.set(plan_id, plan);
            return PromiseOrValue::Value(None);
        }

        // Before anything moves: a short swap call must fail whole, not strand a request in a callback (red team M3).
        if matches!(plan.action, PlanAction::SwapWithFloor { .. }) {
            require!(env::prepaid_gas() >= MIN_SWAP_STEP_GAS, "SWAP_STEP_NEEDS_300_TGAS");
        }

        // The rules changed since `create_plan`, and only the owner can settle that.
        if let Some(reason) = self.plan_limit_failure(&plan.action, amount.0) {
            self.halt_plan(&mut plan, PlanPauseReason::Failures, &reason);
            self.plans.set(plan_id, plan);
            return PromiseOrValue::Value(None);
        }
        if policy::spent(&self.spends, now).saturating_add(amount.0) > self.policy.max_per_day.0 {
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
        policy::add_spend(&mut self.spends, now, amount.0);
        let guard = env::current_account_id();
        // The slot, not the run: a run that failed is tried again under a new id, and its old record stays.
        let request_id = format!("{}{plan_id}-{due}", policy::PLAN_REQUEST_PREFIX);
        let memo = format!("plan {plan_id} run {run}");
        let description = policy::description(&request_id, guard.as_str(), Decision::Auto, &[], &memo);
        let receiver_id = match &plan.action {
            PlanAction::Transfer { receiver_id } => receiver_id.clone(),
            PlanAction::Call { target, .. } => target.clone(),
            PlanAction::Swap { .. } | PlanAction::SwapWithFloor { .. } => {
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
            PlanAction::SwapWithFloor { pool_id, token_out, .. } => Some((*pool_id, token_out.clone())),
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
        self.agent_spends.remove(&account_id);
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

    /// Deletes the Guard with the DAO as beneficiary, so its whole balance (the locked storage included) goes back to
    /// the DAO. Refused while a request waits for a vote or a plan can still run (`Paused` can be resumed: cancel it
    /// first). NEAR refuses to delete an account that holds over 10 KB of data, so the Guard first removes its
    /// records; a Guard that has seen more than `MAX_RECENT` requests cannot find the older ones and stays open
    /// (`withdraw_excess` still empties it down to its storage).
    #[payable]
    pub fn close(&mut self) -> Promise {
        self.assert_dao();
        require!(self.recent_total <= MAX_RECENT as u64, "TOO_MANY_RECORDS");
        require!(
            self.plans.iter().all(|p| matches!(p.status, PlanStatus::Completed | PlanStatus::Cancelled)),
            "OPEN_PLANS"
        );
        let ids: Vec<String> = self.recent.iter().cloned().collect();
        for id in &ids {
            if let Some(r) = self.requests.remove(id) {
                require!(!r.status.holds_pending(), "OPEN_REQUESTS");
                if let Some(p) = r.proposal_id {
                    self.by_proposal.remove(&p);
                }
            }
        }
        self.recent.clear();
        self.plans.clear();
        self.agents.clear();
        self.whitelist.clear();
        self.guardians.clear();
        emit("guard_closed", json!({ "beneficiary": self.dao_id, "balance": U128(env::account_balance().as_yoctonear()) }));
        Promise::new(env::current_account_id()).delete_account(self.dao_id.clone())
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
            "requests": U64(self.recent_total),
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

    /// `spent_24h` is the agent's part of `get_window`'s `spent_in_window`, over the same rolling 24 h.
    pub fn get_agents(&self) -> Vec<Value> {
        let now = env::block_timestamp();
        self.agents
            .iter()
            .map(|(id, a)| {
                let spent = U128(self.agent_spends.get(id).map_or(0, |s| policy::spent(s, now)));
                json!({ "account_id": id, "label": a.label, "enabled": a.enabled && !a.creating, "pending": a.pending, "spent_24h": spent })
            })
            .collect()
    }

    /// The rolling 24 h window as the next request would see it. `resets_at` is when the oldest spend that still
    /// counts drops out and frees part of the limit (`now` when nothing counts).
    pub fn get_window(&self) -> Value {
        let now = env::block_timestamp();
        let spent = policy::spent(&self.spends, now);
        json!({
            "window_start": U64(now.saturating_sub(policy::DAY_NS)),
            "resets_at": U64(policy::frees_at(&self.spends, now)),
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
        json!({ "standard": "kd_guard", "version": "1.6.0", "dao_id": self.dao_id })
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
    /// 1.5.0 wrote this layout without `spends` and `agent_spends`, so its bytes never parse as the full layout:
    /// they get those two fields appended empty, then its window moves over (`carry_window`).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let state = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("NO_STATE"));
        if let Ok(guard) = near_sdk::borsh::from_slice::<Self>(&state) {
            return guard;
        }
        let tail = (policy::Spends::new(), LookupMap::<AccountId, policy::Spends>::new(StorageKey::AgentSpends));
        let tail = near_sdk::borsh::to_vec(&tail).unwrap_or_else(|_| env::panic_str("UNKNOWN_STATE"));
        let mut guard: Self =
            near_sdk::borsh::from_slice(&[state, tail].concat()).unwrap_or_else(|_| env::panic_str("UNKNOWN_STATE"));
        guard.carry_window(env::block_timestamp());
        guard
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

    /// 1.5.0's window, if it has not ended, goes into the current hour. 1.5.0 did not record when in the window each
    /// payment was, and the last could be this minute, so it counts 24 to 25 h from now: never less than a rolling
    /// window would, at worst a day longer than the old reset. The agents' parts move the same way.
    fn carry_window(&mut self, now: u64) {
        let start = self.window_start;
        if now < start.saturating_add(policy::DAY_NS) {
            if self.spent_in_window > 0 {
                policy::add_spend(&mut self.spends, now, self.spent_in_window);
            }
            let parts: Vec<(AccountId, u128)> = self
                .agents
                .iter()
                .filter(|(_, a)| a.spent_window.0 == start && a.spent.0 > 0)
                .map(|(id, a)| (id.clone(), a.spent.0))
                .collect();
            for (id, amount) in parts {
                policy::add_spend(self.agent_spends.entry(id).or_default(), now, amount);
            }
        }
        self.window_start = 0;
        self.spent_in_window = 0;
    }

    fn plan(&self, plan_id: u32) -> Plan {
        self.plans.get(plan_id).cloned().unwrap_or_else(|| env::panic_str("UNKNOWN_PLAN"))
    }

    /// The first limit a run of this size breaks even in an empty window, so waiting for the window will not help.
    fn plan_limit_failure(&self, action: &PlanAction, amount: u128) -> Option<String> {
        let wl = match action {
            PlanAction::Transfer { receiver_id } => self.whitelist.get(receiver_id),
            PlanAction::Call { .. } | PlanAction::Swap { .. } | PlanAction::SwapWithFloor { .. } => None,
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
                    PlanAction::Transfer { .. } | PlanAction::Swap { .. } | PlanAction::SwapWithFloor { .. } => {
                        PlanPauseReason::InsufficientBalance
                    }
                    PlanAction::Call { .. } => PlanPauseReason::Failures,
                };
                self.halt_plan(&mut plan, reason, "VOTE_FAILED");
            }
            _ => return,
        }
        self.plans.set(plan_id, plan);
    }

    /// Moves a request to `status`: frees the agent's pending slot when the request stops waiting on the DAO, and
    /// gives the daily limit back when counted money did not leave, while its spend still counts.
    fn finish(&mut self, r: &mut RequestRecord, status: RequestStatus, now: u64) {
        if let Some(plan_id) = r.plan_id {
            self.move_plan(r, plan_id, status);
        }
        self.settle(r, status, now);
    }

    /// `finish` without the plan move: the pending slot, the daily limit and the status.
    fn settle(&mut self, r: &mut RequestRecord, status: RequestStatus, now: u64) {
        if r.status.holds_pending() && !status.holds_pending() {
            if let Some(a) = self.agents.get_mut(&r.agent) {
                a.pending = a.pending.saturating_sub(1);
            }
        }
        // Off the hour the request was counted in: a refund into a later hour would free room it never took.
        if status.is_final()
            && status != RequestStatus::Executed
            && r.counted_in_window
            && policy::refund_spend(&mut self.spends, r.created_at.0, now, r.amount.0)
        {
            r.counted_in_window = false;
            if let Some(mine) = self.agent_spends.get_mut(&r.agent) {
                policy::refund_spend(mine, r.created_at.0, now, r.amount.0);
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
        PlanAction::Swap { .. } | PlanAction::SwapWithFloor { .. } => env::panic_str("SWAP_KIND_AT_RUN_TIME"),
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
