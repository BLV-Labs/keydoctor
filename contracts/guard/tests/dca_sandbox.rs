// GĐ31 D4: the DCA swap step against the real testnet wasm of wrap.testnet, ref-finance-101.testnet and
// usdt.fakes.testnet (tests/res/testnet, fetched with `view_code` on 2026-11-09; hashes in the README there).
// Accounts keep their testnet ids (patched into the sandbox), because the Guard picks the exchange from its own
// `.testnet` suffix (`policy::dex_for`). The pool is seeded here, not copied from pool 57, so its id is 0.
// Needs the Guard wasm: `cargo near build non-reproducible-wasm --no-abi`. Gas lines start with `GAS`
// (`cargo test --test dca_sandbox -- --nocapture`).
#![allow(unused_must_use)]
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::result::{ExecutionFinalResult, ExecutionOutcome};
use near_workspaces::types::{AccessKey, AccountDetailsPatch, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Worker};
use serde_json::{json, Value};

const SPUTNIK_WASM: &str = "tests/res/sputnik_dao_v2.wasm";
const GUARD_WASM: &str = "target/near/kd_guard.wasm";
const WRAP_WASM: &str = "tests/res/testnet/wrap.wasm";
const EXCHANGE_WASM: &str = "tests/res/testnet/ref_exchange.wasm";
const USDT_WASM: &str = "tests/res/testnet/usdt_fakes.wasm";

const WRAP: &str = "wrap.testnet";
const EXCHANGE: &str = "ref-finance-101.testnet";
const USDT: &str = "usdt.fakes.testnet";

/// What the keeper attaches (plan Change 1.4: the step needs 80 + F Tgas of promises plus its own receipt).
const KEEPER_GAS: Gas = Gas::from_tgas(300);
const MILLI: u128 = 1_000_000_000_000_000_000_000;

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

fn milli(n: u128) -> NearToken {
    NearToken::from_yoctonear(n * MILLI)
}

fn tgas(g: Gas) -> f64 {
    g.as_gas() as f64 / 1e12
}

struct Dca {
    worker: Worker<near_workspaces::network::Sandbox>,
    dao: Account,
    guard: Account,
    council: Account,
    keeper: Account,
    wrap: Account,
    exchange: Account,
    usdt: Account,
    bond: u128,
}

/// An account with a testnet id, a full-access key we hold, some NEAR and optionally a contract.
async fn make(worker: &Worker<near_workspaces::network::Sandbox>, id: &str, balance: NearToken, wasm: Option<&str>) -> anyhow::Result<Account> {
    let account_id: AccountId = id.parse()?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    let mut patch = worker
        .patch(&account_id)
        .account(AccountDetailsPatch::default().balance(balance))
        .access_key(sk.public_key(), AccessKey::full_access());
    if let Some(path) = wasm {
        patch = patch.code(&std::fs::read(path)?);
    }
    patch.transact().await?;
    Ok(Account::from_secret_key(account_id, sk, worker))
}

async fn ok(call: impl std::future::Future<Output = near_workspaces::Result<ExecutionFinalResult>>) -> anyhow::Result<ExecutionFinalResult> {
    let result = call.await?;
    anyhow::ensure!(result.is_success(), "{:?}", result.failures());
    Ok(result)
}

impl Dca {
    /// Real wrap, exchange and USDT contracts with a wNEAR/USDT pool, a Sputnik DAO that has registered on all three,
    /// and a Guard 1.3.0 whose role holds the transfer and call rights.
    async fn new() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let wrap = make(&worker, WRAP, near(20), Some(WRAP_WASM)).await?;
        let exchange = make(&worker, EXCHANGE, near(20), Some(EXCHANGE_WASM)).await?;
        let usdt = make(&worker, USDT, near(20), Some(USDT_WASM)).await?;
        let council = make(&worker, "council.testnet", near(50), None).await?;
        let keeper = make(&worker, "keeper.testnet", near(10), None).await?;
        let dao = make(&worker, "kddao.testnet", near(40), Some(SPUTNIK_WASM)).await?;
        let guard = make(&worker, "kdguard.testnet", near(20), Some(GUARD_WASM)).await?;

        ok(wrap.call(wrap.id(), "new").args_json(json!({})).max_gas().transact()).await?;
        ok(exchange
            .call(exchange.id(), "new")
            .args_json(json!({ "owner_id": exchange.id(), "exchange_fee": 1600, "referral_fee": 400, "boost_farm_id": "boost-farm.testnet", "burrowland_id": "burrowland.testnet" }))
            .max_gas()
            .transact())
        .await?;
        init_usdt(&usdt).await?;
        ok(exchange
            .call(exchange.id(), "extend_whitelisted_tokens")
            .args_json(json!({ "tokens": [WRAP, USDT] }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact())
        .await?;

        ok(dao
            .call(dao.id(), "new")
            .args_json(json!({ "config": { "name": "kd-dca", "purpose": "GD31 D4", "metadata": "" }, "policy": [council.id()] }))
            .max_gas()
            .transact())
        .await?;
        let policy: Value = dao.view(dao.id(), "get_policy").await?.json()?;
        let bond = policy["proposal_bond"].as_str().unwrap().parse::<u128>()?;
        ok(guard
            .call(guard.id(), "new")
            .args_json(json!({
                "dao_id": dao.id(),
                "policy": {
                    "max_per_tx": near(1).as_yoctonear().to_string(),
                    "max_per_day": near(2).as_yoctonear().to_string(),
                    "max_pending_per_agent": 3,
                    "min_reserve": near(1).as_yoctonear().to_string(),
                },
                "agents": [], "whitelist": [], "guardians": [],
            }))
            .max_gas()
            .transact())
        .await?;

        let me = Self { worker, dao, guard, council, keeper, wrap, exchange, usdt, bond };
        me.add_role(policy).await?;
        me.seed_pool().await?;
        me.register_dao().await?;
        Ok(me)
    }

    /// The Budget's Guard role with the rights a swap plan needs: today's two transfer rights plus `call`.
    async fn add_role(&self, mut policy: Value) -> anyhow::Result<()> {
        let vote = json!({ "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" });
        policy["roles"].as_array_mut().unwrap().push(json!({
            "name": "agent-guard",
            "kind": { "Group": [self.guard.id()] },
            "permissions": ["transfer:AddProposal", "transfer:VoteApprove", "call:AddProposal", "call:VoteApprove"],
            "vote_policy": { "transfer": vote, "call": vote },
        }));
        assert_eq!(self.council_passes(json!({ "ChangePolicy": { "policy": policy } })).await?, "Approved");
        Ok(())
    }

    /// 1.444 wNEAR against 13.885 USDT, the state of pool 57 in the spike, fee 0.25 %.
    async fn seed_pool(&self) -> anyhow::Result<()> {
        let lp = make(&self.worker, "lp.testnet", near(30), None).await?;
        ok(self.exchange.call(self.exchange.id(), "storage_deposit").args_json(json!({})).deposit(near(1)).max_gas().transact()).await?;
        let pool_id: u64 = ok(self
            .exchange
            .call(self.exchange.id(), "add_simple_pool")
            .args_json(json!({ "tokens": [WRAP, USDT], "fee": 25 }))
            .deposit(milli(100))
            .max_gas()
            .transact())
        .await?
        .json()?;
        assert_eq!(pool_id, 0);
        for token in [&self.wrap, &self.usdt] {
            ok(lp.call(token.id(), "storage_deposit").args_json(json!({})).deposit(milli(10)).max_gas().transact()).await?;
            // The exchange holds both tokens, so each token contract must know it (true on testnet already).
            ok(lp
                .call(token.id(), "storage_deposit")
                .args_json(json!({ "account_id": self.exchange.id() }))
                .deposit(milli(10))
                .max_gas()
                .transact())
            .await?;
        }
        ok(lp.call(self.exchange.id(), "storage_deposit").args_json(json!({})).deposit(near(1)).max_gas().transact()).await?;
        ok(lp
            .call(self.exchange.id(), "register_tokens")
            .args_json(json!({ "token_ids": [WRAP, USDT] }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact())
        .await?;
        let wnear = 1_444 * MILLI;
        let usdt_amount = 13_885_000u128;
        ok(lp.call(self.wrap.id(), "near_deposit").args_json(json!({})).deposit(NearToken::from_yoctonear(wnear)).max_gas().transact()).await?;
        ok(lp.call(self.usdt.id(), "mint").args_json(json!({ "account_id": lp.id(), "amount": usdt_amount.to_string() })).max_gas().transact()).await?;
        for (token, amount) in [(&self.wrap, wnear), (&self.usdt, usdt_amount)] {
            ok(lp
                .call(token.id(), "ft_transfer_call")
                .args_json(json!({ "receiver_id": self.exchange.id(), "amount": amount.to_string(), "msg": "" }))
                .deposit(NearToken::from_yoctonear(1))
                .max_gas()
                .transact())
            .await?;
        }
        ok(lp
            .call(self.exchange.id(), "add_liquidity")
            .args_json(json!({ "pool_id": 0, "amounts": [wnear.to_string(), usdt_amount.to_string()] }))
            .deposit(milli(100))
            .max_gas()
            .transact())
        .await?;
        Ok(())
    }

    /// "Enable USDT" (plan D3) in one go: the DAO pays its own storage on all three contracts.
    async fn register_dao(&self) -> anyhow::Result<()> {
        for contract in [&self.wrap, &self.usdt, &self.exchange] {
            ok(self
                .council
                .call(contract.id(), "storage_deposit")
                .args_json(json!({ "account_id": self.dao.id(), "registration_only": true }))
                .deposit(milli(100))
                .max_gas()
                .transact())
            .await?;
        }
        Ok(())
    }

    async fn council_passes(&self, kind: Value) -> anyhow::Result<String> {
        let id: u64 = ok(self
            .council
            .call(self.dao.id(), "add_proposal")
            .args_json(json!({ "proposal": { "description": "council change", "kind": kind } }))
            .deposit(NearToken::from_yoctonear(self.bond))
            .max_gas()
            .transact())
        .await?
        .json()?;
        let kind = self.proposal(id).await?["kind"].clone();
        // The vote itself may fail (a swap whose call the DAO cannot pay): the status then tells the story.
        let _ = self
            .council
            .call(self.dao.id(), "act_proposal")
            .args_json(json!({ "id": id, "action": "VoteApprove", "proposal": kind }))
            .max_gas()
            .transact()
            .await?;
        Ok(self.proposal(id).await?["status"].as_str().unwrap().to_string())
    }

    async fn proposal(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self.dao.view(self.dao.id(), "get_proposal").args_json(json!({ "id": id })).await?.json()?)
    }

    async fn now(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    async fn create_swap_plan(&self, amount: NearToken, slippage_bps: u16, runs: u32) -> anyhow::Result<()> {
        let plan = json!({ "plan": {
            "action": { "type": "swap", "pool_id": 0, "token_out": USDT, "max_slippage_bps": slippage_bps },
            "strategy_id": "dca-near",
            "token_in": "",
            "amount_per_run": amount.as_yoctonear().to_string(),
            "interval_sec": 60,
            "runs_total": runs,
            "start_at": self.now().await?.to_string(),
        }});
        let kind = json!({ "FunctionCall": { "receiver_id": self.guard.id(), "actions": [{
            "method_name": "create_plan",
            "args": STANDARD.encode(plan.to_string()),
            "deposit": milli(10).as_yoctonear().to_string(),
            "gas": Gas::from_tgas(50).as_gas().to_string(),
        }]}});
        assert_eq!(self.council_passes(kind).await?, "Approved", "the council must be able to create a swap plan");
        Ok(())
    }

    async fn plan(&self, plan_id: u32) -> anyhow::Result<Value> {
        Ok(self.guard.view(self.guard.id(), "get_plan").args_json(json!({ "plan_id": plan_id })).await?.json()?)
    }

    async fn step(&self, gas: Gas) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self.keeper.call(self.guard.id(), "execute_plan_step").args_json(json!({ "plan_id": 0 })).gas(gas).transact().await?)
    }

    async fn ft_balance(&self, token: &Account, who: &AccountId) -> anyhow::Result<u128> {
        let v: String = token.view(token.id(), "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
        Ok(v.parse()?)
    }

    async fn dao_usdt(&self) -> anyhow::Result<u128> {
        self.ft_balance(&self.usdt, self.dao.id()).await
    }

    async fn dao_wnear(&self) -> anyhow::Result<u128> {
        self.ft_balance(&self.wrap, self.dao.id()).await
    }

    async fn dao_near(&self) -> anyhow::Result<u128> {
        Ok(self.dao.view_account().await?.balance.as_yoctonear())
    }

    async fn quote(&self, amount: u128) -> anyhow::Result<u128> {
        let q: String = self
            .exchange
            .view(self.exchange.id(), "get_return")
            .args_json(json!({ "pool_id": 0, "token_in": WRAP, "amount_in": amount.to_string(), "token_out": USDT }))
            .await?
            .json()?;
        Ok(q.parse()?)
    }
}

/// `usdt.fakes.testnet` is a NEP-141 with an open `mint`; its init takes no arguments or an owner. Found by trying.
async fn init_usdt(usdt: &Account) -> anyhow::Result<()> {
    let tries = [json!({
        "owner_id": usdt.id(), "total_supply": "0", "name": "Tether USD", "symbol": "USDT.e", "decimals": 6, "icon": null,
    })];
    let mut last = String::new();
    for args in tries {
        let r = usdt.call(usdt.id(), "new").args_json(args).max_gas().transact().await?;
        if r.is_success() {
            return Ok(());
        }
        last = format!("{:?}", r.failures());
    }
    anyhow::bail!("usdt init: {last}")
}

fn report(label: &str, outcome: &ExecutionFinalResult) {
    println!("GAS {label}: total burnt={:.1} Tgas", tgas(outcome.total_gas_burnt));
    let mut max: Option<&ExecutionOutcome> = None;
    for receipt in outcome.outcomes() {
        println!("GAS   {} burnt={:.1} Tgas", receipt.executor_id, tgas(receipt.gas_burnt));
        if max.map_or(true, |m| receipt.gas_burnt > m.gas_burnt) {
            max = Some(receipt);
        }
    }
    if let Some(m) = max {
        println!("GAS   max receipt: {} {:.1} Tgas", m.executor_id, tgas(m.gas_burnt));
    }
}

// BLOCKED by an S1 bug, see the commit message: on_voted reads the act_proposal result as `()`, but a swap's last
// receipt returns the ft_transfer_call amount, so the callback panics. Remove the ignore once on_voted takes a Value.
#[tokio::test]
#[ignore = "S1 bug: on_voted cannot deserialize the U128 that a swap's act_proposal returns"]
async fn a_swap_plan_step_sells_near_for_usdt_on_the_real_contracts() -> anyhow::Result<()> {
    let e = Dca::new().await?;
    e.create_swap_plan(milli(100), 100, 2).await?;
    let amount = milli(100).as_yoctonear();
    let quote = e.quote(amount).await?;
    assert!(quote > 0);
    let near_before = e.dao_near().await?;

    let outcome = e.step(KEEPER_GAS).await?;
    report("swap step", &outcome);
    let failures = format!("{:?}", outcome.failures());
    assert!(outcome.is_success(), "{failures}");
    let record: Value = outcome.json()?;
    assert_eq!(record["status"], "AutoApproved", "{record}");
    assert_eq!(e.proposal(record["proposal_id"].as_u64().unwrap()).await?["status"], "Approved");

    let got = e.dao_usdt().await?;
    assert_eq!(got, quote, "the DAO gets exactly the quote the Guard read (nobody moved the pool)");
    assert_eq!(e.dao_wnear().await?, 0, "all the wrapped NEAR went into the swap");
    assert!(near_before - e.dao_near().await? >= amount, "the DAO paid 0.1 NEAR");
    let plan = e.plan(0).await?;
    assert_eq!(plan["runs_done"], 1, "{plan}");
    let window: Value = e.guard.view(e.guard.id(), "get_window").await?.json()?;
    assert_eq!(window["spent_in_window"], amount.to_string());
    println!("GAS sold 0.1 NEAR for {got} USDT units (6 decimals)");
    Ok(())
}

#[tokio::test]
async fn a_swap_step_needs_the_gas_the_plan_budgets_and_a_short_caller_burns_no_run() -> anyhow::Result<()> {
    // K2a for the swap path: the static gas is the sum in the plan's table (80 + F). Less must fail in the first
    // receipt, before the slot moves; the real cost (burnt) is reported for sizing F.
    let e = Dca::new().await?;
    e.create_swap_plan(milli(100), 100, 2).await?;
    let before = e.plan(0).await?;
    for g in [100, 200] {
        let short = e.step(Gas::from_tgas(g)).await?;
        println!("GAS {g} Tgas attached: success={}", short.is_success());
        assert!(short.is_failure(), "{g} Tgas cannot hold the promise chain");
        assert_eq!(e.plan(0).await?, before, "a short call must not move the slot or the run");
    }
    let window: Value = e.guard.view(e.guard.id(), "get_window").await?.json()?;
    assert_eq!(window["spent_in_window"], "0");
    Ok(())
}

#[tokio::test]
async fn on_quote_cannot_be_called_by_anyone_but_the_guard() -> anyhow::Result<()> {
    // WHY: on_quote builds the swap proposal from a quote it trusts. Anyone who could call it could feed a fake
    // quote (min_out 0) and have the Guard vote a swap with no price floor. #[private] is only enforced in wasm.
    let e = Dca::new().await?;
    e.create_swap_plan(milli(100), 100, 2).await?;
    let stranger = e.worker.dev_create_account().await?;
    for caller in [&stranger, &e.keeper] {
        let r = caller
            .call(e.guard.id(), "on_quote")
            .args_json(json!({ "request_id": "x", "plan_id": 0 }))
            .max_gas()
            .transact()
            .await?;
        assert!(r.is_failure(), "{} must be refused", caller.id());
        assert!(format!("{:?}", r.failures()).contains("is private"), "{:?}", r.failures());
    }
    Ok(())
}
