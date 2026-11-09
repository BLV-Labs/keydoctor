// The factory in a local sandbox against the Sputnik v2 wasm testnet DAOs run. A DAO creates a Guard through a
// FunctionCall proposal, the council adds the `agent-guard` role, and the factory-made Guard pays Auto and holds
// Pending exactly like a hand-deployed one. Prints the deposit and gas the dashboard attaches (`-- --nocapture`,
// lines starting with `COST`).
// Needs both wasm files: `cargo near build non-reproducible-wasm --no-abi` in contracts/guard and here
// (`pnpm test:guard` does it).
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const SPUTNIK_WASM: &str = "../guard/tests/res/sputnik_dao_v2.wasm";
const GUARD_WASM: &str = "../guard/target/near/kd_guard.wasm";
const FACTORY_WASM: &str = "target/near/kd_guard_factory.wasm";
// What the dashboard puts on the proposal's FunctionCall action.
const CREATE_GAS: Gas = Gas::from_tgas(220);
// The least `create` accepts (MIN_CREATE_GAS in the factory).
const LEAST_CREATE_GAS: Gas = Gas::from_tgas(215);
const REQUEST_GAS: Gas = Gas::from_tgas(200);
const SIGN_2_ADD_TGAS: u64 = 15;
const SIGN_2_ACT_CREATE_TGAS: u64 = 245;
const SIGN_2_ACT_ROLE_TGAS: u64 = 25;
const RECORD_ALLOWANCE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR, RECORD_STORAGE_YOCTO in the dashboard

struct Env {
    worker: Worker<near_workspaces::network::Sandbox>,
    dao: Contract,
    factory: Contract,
    council: Account,
    agent: Account,
    receiver: Account,
    stranger: Account,
    bond: u128,
}

fn yocto(t: NearToken) -> String {
    t.as_yoctonear().to_string()
}

/// A Sputnik DAO with one council member, and the factory initialised with the Guard code. The factory account
/// only locks the storage for the code it keeps; each Guard's copy is paid by the DAO that creates it.
async fn setup() -> anyhow::Result<Env> {
    setup_with(&std::fs::read(FACTORY_WASM).expect("build the factory wasm first")).await
}

async fn setup_with(factory_wasm: &[u8]) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact();
    let council = sub("council", 20).await?.into_result()?;
    let agent = sub("agent", 5).await?.into_result()?;
    let receiver = sub("receiver", 1).await?.into_result()?;
    let stranger = sub("stranger", 20).await?.into_result()?;
    let dao = sub("dao", 50).await?.into_result()?;
    let factory = sub("factory", 8).await?.into_result()?; // what setup.sh gives the testnet factory

    let dao = dao.deploy(&std::fs::read(SPUTNIK_WASM)?).await?.into_result()?;
    dao.call("new")
        .args_json(json!({ "config": { "name": "kd-factory", "purpose": "factory test", "metadata": "" }, "policy": [council.id()] }))
        .transact()
        .await?
        .into_result()?;
    let policy: Value = dao.view("get_policy").await?.json()?;
    let bond = policy["proposal_bond"].as_str().unwrap().parse::<u128>()?;

    let factory = factory.deploy(factory_wasm).await?.into_result()?;
    let code = std::fs::read(GUARD_WASM).expect("build the Guard wasm first (contracts/guard)");
    // `new` takes the code as borsh `Vec<u8>`: u32 length, then the bytes.
    let mut args = (code.len() as u32).to_le_bytes().to_vec();
    args.extend(code);
    factory.call("new").args(args).max_gas().transact().await?.into_result()?;

    Ok(Env { worker, dao, factory, council, agent, receiver, stranger, bond })
}

impl Env {
    async fn council_passes(&self, kind: Value) -> anyhow::Result<String> {
        let id: u64 = self
            .council
            .call(self.dao.id(), "add_proposal")
            .args_json(json!({ "proposal": { "description": "council change", "kind": kind } }))
            .deposit(NearToken::from_yoctonear(self.bond))
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json()?;
        let kind = self.dao.view("get_proposal").args_json(json!({ "id": id })).await?.json::<Value>()?["kind"].clone();
        self.council
            .call(self.dao.id(), "act_proposal")
            .args_json(json!({ "id": id, "action": "VoteApprove", "proposal": kind }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        let p: Value = self.dao.view("get_proposal").args_json(json!({ "id": id })).await?.json()?;
        Ok(p["status"].as_str().unwrap().to_string())
    }

    fn create_args(&self, name: &str) -> Value {
        json!({
            "name": name,
            "policy": {
                "max_per_tx": yocto(NearToken::from_near(1)),
                "max_per_day": yocto(NearToken::from_near(2)),
                "max_pending_per_agent": 3,
                "min_reserve": yocto(NearToken::from_near(1)),
            },
            "agents": [{ "account_id": self.agent.id(), "label": "payroll bot" }],
            "whitelist": [{ "account_id": self.receiver.id(), "label": "vendor", "max_per_tx": null }],
            "guardians": [],
        })
    }

    /// `create_args` with `n` agents whose accounts the new Guard creates.
    fn keyed_args(&self, name: &str, n: usize) -> (Value, Vec<String>) {
        let mut args = self.create_args(name);
        let guard = format!("{name}.{}", self.factory.id());
        let ids: Vec<String> = (0..n).map(|i| format!("a{i}.{guard}")).collect();
        args["agents"] = ids
            .iter()
            .map(|id| json!({ "account_id": id, "label": "bot", "public_key": SecretKey::from_random(KeyType::ED25519).public_key().to_string() }))
            .collect();
        (args, ids)
    }

    /// The longest input a Guard takes for one agent: every whitelist slot, with long ids and labels.
    fn longest_args(&self, name: &str) -> Value {
        let (mut args, _) = self.keyed_args(name, 1);
        args["whitelist"] = (0..50)
            .map(|i| json!({ "account_id": format!("{i:02}-{}.testnet", "v".repeat(24)), "label": "l".repeat(64), "max_per_tx": null }))
            .collect();
        args
    }

    /// What every Guard's code locks on its account; the dashboard adds it to the funding.
    async fn code_storage(&self) -> anyhow::Result<u128> {
        let meta: Value = self.factory.view("kd_factory_metadata").await?.json()?;
        Ok(meta["guard_code_storage"].as_str().unwrap().parse()?)
    }

    /// P1 of the dashboard flow: the DAO calls `factory.create` with `funding` plus the code storage and the
    /// registry record allowance, as the dashboard computes the deposit.
    async fn dao_creates(&self, name: &str, funding: NearToken) -> anyhow::Result<String> {
        self.dao_creates_with(self.create_args(name), funding).await
    }

    async fn dao_creates_with(&self, args: Value, funding: NearToken) -> anyhow::Result<String> {
        self.dao_creates_on(args, funding, CREATE_GAS).await
    }

    async fn dao_creates_on(&self, args: Value, funding: NearToken, gas: Gas) -> anyhow::Result<String> {
        let deposit = NearToken::from_yoctonear(funding.as_yoctonear() + self.code_storage().await? + RECORD_ALLOWANCE);
        let kind = json!({ "FunctionCall": { "receiver_id": self.factory.id(), "actions": [{
            "method_name": "create",
            "args": STANDARD.encode(args.to_string()),
            "deposit": yocto(deposit),
            "gas": gas.as_gas().to_string(),
        }]}});
        self.council_passes(kind).await
    }

    /// P2: the whole current policy plus the `agent-guard` role, as the dashboard builds it.
    async fn dao_adds_role(&self, guard: &str) -> anyhow::Result<String> {
        let mut policy: Value = self.dao.view("get_policy").await?.json()?;
        policy["roles"].as_array_mut().unwrap().push(json!({
            "name": "agent-guard",
            "kind": { "Group": [guard] },
            "permissions": ["transfer:AddProposal", "transfer:VoteApprove"],
            "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" } }
        }));
        self.council_passes(json!({ "ChangePolicy": { "policy": policy } })).await
    }

    fn guard_id(&self, name: &str) -> String {
        format!("{name}.{}", self.factory.id())
    }

    async fn guards_of(&self, dao: &str) -> anyhow::Result<Value> {
        Ok(self.factory.view("get_guards_for_dao").args_json(json!({ "dao_id": dao })).await?.json()?)
    }

    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        Ok(self.worker.view_account(&account.parse()?).await?.balance.as_yoctonear())
    }
}

#[tokio::test]
async fn a_dao_creates_a_locked_guard_that_pays_auto_and_holds_pending() -> anyhow::Result<()> {
    let e = setup().await?;
    let guard = e.guard_id("acme");
    let funding = NearToken::from_near(5);
    assert_eq!(e.dao_creates("acme", funding).await?, "Approved");

    let listed = e.guards_of(e.dao.id().as_str()).await?;
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    assert_eq!((listed[0]["guard_id"].as_str(), listed[0]["ready"].as_bool()), (Some(guard.as_str()), Some(true)));

    let gid: near_workspaces::AccountId = guard.parse()?;
    let config: Value = e.factory.as_account().view(&gid, "get_config").await?.json()?;
    assert_eq!(config["dao_id"], e.dao.id().as_str(), "the Guard answers to the DAO that called create");
    assert_eq!(config["proposal_bond"], e.bond.to_string(), "the Guard's init read the DAO policy");
    let keys = e.worker.view_access_keys(&gid).await?;
    assert!(keys.is_empty(), "a key on the Guard would let its holder redeploy or drain it: {keys:?}");
    let balance = e.balance(&guard).await?;
    let code_storage = e.code_storage().await?;
    println!("COST guard code storage = {:.4} NEAR, guard balance after create with {funding} funding = {:.4} NEAR", code_storage as f64 / 1e24, balance as f64 / 1e24);
    assert!(balance >= funding.as_yoctonear() + code_storage, "the DAO's deposit pays the Guard's code and its funding");
    let factory_left = e.factory.view_account().await?.balance.as_yoctonear();
    println!("COST factory balance after create = {:.4} NEAR", factory_left as f64 / 1e24);

    assert_eq!(e.dao_adds_role(&guard).await?, "Approved");

    let request = |id: &'static str, to: &Account, near_milli: u128| {
        e.agent
            .call(&gid, "request_transfer")
            .args_json(json!({ "request_id": id, "receiver_id": to.id(), "amount": yocto(NearToken::from_millinear(near_milli)), "memo": "factory" }))
            .gas(REQUEST_GAS)
            .transact()
    };
    let before = e.balance(e.receiver.id().as_str()).await?;
    let auto: Value = request("auto-0001", &e.receiver, 100).await?.into_result()?.json()?;
    assert_eq!(auto["status"], "AutoApproved", "{auto}");
    assert_eq!(e.balance(e.receiver.id().as_str()).await? - before, NearToken::from_millinear(100).as_yoctonear());

    let pending: Value = request("pend-0001", &e.stranger, 100).await?.into_result()?.json()?;
    assert_eq!((pending["status"].as_str(), pending["reasons"][0].as_str()), (Some("Pending"), Some("NOT_WHITELISTED")));
    Ok(())
}

#[tokio::test]
async fn a_plain_account_gets_its_deposit_back_and_no_guard() -> anyhow::Result<()> {
    // `get_policy` is what keeps non-DAOs out: without it anyone could fill the registry with fake DAO entries.
    let e = setup().await?;
    let before = e.balance(e.stranger.id().as_str()).await?;
    let outcome = e
        .stranger
        .call(e.factory.id(), "create")
        .args_json(e.create_args("fake"))
        .deposit(NearToken::from_near(3))
        .gas(CREATE_GAS)
        .transact()
        .await?;
    println!("COST create by a non-DAO burnt={:.1} Tgas", outcome.total_gas_burnt.as_gas() as f64 / 1e12);
    let lost = before - e.balance(e.stranger.id().as_str()).await?;
    assert!(lost < NearToken::from_millinear(10).as_yoctonear(), "only gas is lost, lost {lost} yocto");
    assert!(e.guards_of(e.stranger.id().as_str()).await?.as_array().unwrap().is_empty());
    let gid: near_workspaces::AccountId = e.guard_id("fake").parse()?;
    assert!(e.worker.view_account(&gid).await.is_err(), "no Guard account may exist");
    Ok(())
}

#[tokio::test]
async fn a_failed_guard_creation_refunds_the_dao_and_frees_the_name() -> anyhow::Result<()> {
    // The account already exists outside the registry, so the create batch fails after the DAO check passed.
    let e = setup().await?;
    e.factory.as_account().create_subaccount("taken").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    let before = e.balance(e.dao.id().as_str()).await?;
    assert_eq!(e.dao_creates("taken", NearToken::from_near(5)).await?, "Approved");
    let after = e.balance(e.dao.id().as_str()).await?;
    assert!(after + NearToken::from_millinear(10).as_yoctonear() > before, "the DAO must get its 5 NEAR back: {before} -> {after}");
    assert!(e.guards_of(e.dao.id().as_str()).await?.as_array().unwrap().is_empty(), "a failed Guard must not be listed");
    assert_eq!(e.dao_creates("acme", NearToken::from_near(5)).await?, "Approved", "the DAO slot is free again");
    assert_eq!(e.guards_of(e.dao.id().as_str()).await?.as_array().unwrap().len(), 1);
    Ok(())
}

#[tokio::test]
async fn only_the_factory_account_can_init_it() -> anyhow::Result<()> {
    // Between the deploy and `new`, a watcher could otherwise init the factory with Guard code of their own.
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let factory = root.create_subaccount("factory").initial_balance(NearToken::from_near(40)).transact().await?.into_result()?;
    let stranger = root.create_subaccount("stranger").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let factory = factory.deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    let code = b"not the guard".to_vec();
    let mut args = (code.len() as u32).to_le_bytes().to_vec();
    args.extend(code);
    let outcome = stranger.call(factory.id(), "new").args(args).max_gas().transact().await?;
    assert!(outcome.is_failure(), "a stranger must not init the factory");
    assert!(factory.view("get_code_hash").await.is_err(), "the factory must still be uninitialised");
    Ok(())
}

// §11.10.2: sign 2 of Budget creation. The agent's account has to exist as soon as the Guard does, on the gas the
// dashboard attaches, for the most agents a Guard accepts.
#[tokio::test]
async fn a_guard_creates_ten_agent_accounts_on_the_dashboards_gas() -> anyhow::Result<()> {
    let e = setup().await?;
    let (args, ids) = e.keyed_args("budget", 10);
    assert_eq!(e.dao_creates_with(args, NearToken::from_near(6)).await?, "Approved");
    let guard: near_workspaces::AccountId = format!("budget.{}", e.factory.id()).parse()?;
    e.worker.view_account(&guard).await?; // an Approved proposal alone does not prove creation
    assert!(e.worker.view_access_keys(&guard).await?.is_empty(), "the Guard stays locked");
    for id in &ids {
        let keys = e.worker.view_access_keys(&id.parse()?).await?;
        assert_eq!(keys.len(), 1, "{id} must exist with its one key");
    }
    Ok(())
}

#[tokio::test]
async fn funding_that_cannot_pay_the_agent_accounts_is_refused_and_refunded() -> anyhow::Result<()> {
    // 0.5 NEAR is enough for a Guard but not for a Guard and its agent's gas fund, which would leave it unable to run.
    let e = setup().await?;
    let before = e.dao.view_account().await?.balance.as_yoctonear();
    let (args, _) = e.keyed_args("budget", 1);
    e.dao_creates_with(args, NearToken::from_millinear(500)).await.ok();
    let guard: near_workspaces::AccountId = format!("budget.{}", e.factory.id()).parse()?;
    assert!(e.worker.view_account(&guard).await.is_err(), "no Guard may exist");
    let after = e.dao.view_account().await?.balance.as_yoctonear();
    assert!(after + NearToken::from_millinear(50).as_yoctonear() >= before, "the DAO keeps its money: {before} -> {after}");
    Ok(())
}

#[tokio::test]
async fn an_agent_name_outside_the_guard_fails_the_creation_and_refunds_the_dao() -> anyhow::Result<()> {
    let e = setup().await?;
    let before = e.dao.view_account().await?.balance.as_yoctonear();
    let mut args = e.create_args("budget");
    args["agents"] = json!([{ "account_id": e.agent.id(), "label": "bot", "public_key": SecretKey::from_random(KeyType::ED25519).public_key().to_string() }]);
    e.dao_creates_with(args, NearToken::from_near(2)).await.ok();
    e.worker.fast_forward(5).await?;
    let guard: near_workspaces::AccountId = format!("budget.{}", e.factory.id()).parse()?;
    assert!(e.worker.view_account(&guard).await.is_err(), "the batch must revert the account");
    let after = e.dao.view_account().await?.balance.as_yoctonear();
    assert!(after + NearToken::from_millinear(50).as_yoctonear() >= before, "the DAO keeps its money: {before} -> {after}");
    Ok(())
}

#[tokio::test]
async fn get_guard_code_returns_the_bytes_of_the_published_hash() -> anyhow::Result<()> {
    // A Guard's `upgrade` hashes this reply, so any wrapping (JSON, base64) would fail every upgrade.
    let e = setup().await?;
    let code = e.factory.view("get_guard_code").await?.result;
    assert_eq!(code, std::fs::read(GUARD_WASM)?);
    Ok(())
}

/// Sign 2 of Agent Budget creation (final-idea 11.10.4): both proposals pass in one wallet transaction, so the 300 Tgas
/// limit must hold the factory call's 220 Tgas and everything around it. The split below is what the dashboard sends.
// Running out of gas in `on_dao_checked` keeps the deposit in the factory, which has no way to give it back. So
// every gas `create` accepts must reach the Guard, or a refund, for the longest input.
#[tokio::test]
async fn the_least_gas_create_accepts_makes_the_guard_from_the_longest_input() -> anyhow::Result<()> {
    let e = setup().await?;
    for (name, gas) in [("least", LEAST_CREATE_GAS), ("dashboard", CREATE_GAS)] {
        assert_eq!(e.dao_creates_on(e.longest_args(name), NearToken::from_near(4), gas).await?, "Approved");
        let guard = e.guard_id(name);
        let view: Value = e.factory.view("get_guard").args_json(json!({ "guard_id": guard })).await?.json()?;
        assert_eq!(view["ready"], true, "{name}: {view}");
    }
    Ok(())
}

#[tokio::test]
async fn less_gas_than_create_accepts_leaves_the_money_with_the_dao() -> anyhow::Result<()> {
    let e = setup().await?;
    let before = e.balance(e.dao.id().as_str()).await?;
    let short = Gas::from_tgas(LEAST_CREATE_GAS.as_tgas() - 1);
    // `create` refuses the call, so the owner's transaction shows the failure and the deposit returns to the DAO.
    let refused = e.dao_creates_on(e.longest_args("short"), NearToken::from_near(4), short).await.unwrap_err();
    assert!(refused.to_string().contains("NOT_ENOUGH_GAS"), "{refused}");
    let after = e.balance(e.dao.id().as_str()).await?;
    assert!(after + NearToken::from_millinear(10).as_yoctonear() > before, "the deposit must come back: {before} -> {after}");
    assert!(e.guards_of(e.dao.id().as_str()).await?.as_array().unwrap().is_empty());
    Ok(())
}

// Ten keyed agents with a full whitelist do not fit in `new`: the Guard is not made, but the money must come back.
#[tokio::test]
async fn too_much_work_for_new_refunds_the_dao_and_frees_the_name() -> anyhow::Result<()> {
    let e = setup().await?;
    let (mut args, _) = e.keyed_args("heavy", 10);
    args["whitelist"] = e.longest_args("heavy")["whitelist"].clone();
    let before = e.balance(e.dao.id().as_str()).await?;
    assert_eq!(e.dao_creates_with(args, NearToken::from_near(8)).await?, "Approved");
    let after = e.balance(e.dao.id().as_str()).await?;
    assert!(after + NearToken::from_millinear(10).as_yoctonear() > before, "the deposit must come back: {before} -> {after}");
    assert!(e.guards_of(e.dao.id().as_str()).await?.as_array().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn sign_2_creates_the_guard_and_its_role_in_one_transaction() -> anyhow::Result<()> {
    let e = setup().await?;
    // A DAO as sign 1 leaves it (§11.10.3): one owner, `*:*`, no other role, and no proposal yet.
    let budget = e.worker.root_account()?.create_subaccount("budget").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let budget = budget.deploy(&std::fs::read(SPUTNIK_WASM)?).await?.into_result()?;
    let bond = NearToken::from_millinear(100).as_yoctonear();
    budget
        .call("new")
        .args_json(json!({
            "config": { "name": "budget", "purpose": "agent budget", "metadata": "" },
            "policy": {
                "roles": [{ "name": "owner", "kind": { "Group": [e.council.id()] }, "permissions": ["*:*"], "vote_policy": {} }],
                "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
                "proposal_bond": bond.to_string(),
                "proposal_period": "259200000000000",
                "bounty_bond": bond.to_string(),
                "bounty_forgiveness_period": "86400000000000",
            },
        }))
        .transact()
        .await?
        .into_result()?;
    let e = Env { dao: budget, bond, ..e };
    let (args, ids) = e.keyed_args("acme", 1);
    let guard = e.guard_id("acme");
    let deposit = NearToken::from_near(3).as_yoctonear() + e.code_storage().await? + RECORD_ALLOWANCE;
    let first: u64 = e.dao.view("get_last_proposal_id").await?.json()?;
    let create = json!({ "FunctionCall": { "receiver_id": e.factory.id(), "actions": [{
        "method_name": "create",
        "args": STANDARD.encode(args.to_string()),
        "deposit": deposit.to_string(),
        "gas": CREATE_GAS.as_gas().to_string(),
    }]}});
    let mut policy: Value = e.dao.view("get_policy").await?.json()?;
    policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "agent-guard",
        "kind": { "Group": [guard] },
        "permissions": ["transfer:AddProposal", "transfer:VoteApprove"],
        "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" } }
    }));
    let role = json!({ "ChangePolicy": { "policy": policy } });
    let add = |kind: &Value, gas: u64| {
        Function::new("add_proposal")
            .args_json(json!({ "proposal": { "description": "budget", "kind": kind } }))
            .deposit(NearToken::from_yoctonear(e.bond))
            .gas(Gas::from_tgas(gas))
    };
    let act = |id: u64, kind: &Value, gas: u64| {
        Function::new("act_proposal").args_json(json!({ "id": id, "action": "VoteApprove", "proposal": kind })).gas(Gas::from_tgas(gas))
    };

    let outcome = e
        .council
        .batch(e.dao.id())
        .call(add(&create, SIGN_2_ADD_TGAS))
        .call(act(first, &create, SIGN_2_ACT_CREATE_TGAS))
        .call(add(&role, SIGN_2_ADD_TGAS))
        .call(act(first + 1, &role, SIGN_2_ACT_ROLE_TGAS))
        .transact()
        .await?;
    println!("COST sign 2 burnt {} Tgas in all", outcome.total_gas_burnt.as_tgas());
    for o in outcome.outcomes() {
        println!("COST sign 2 receipt on {} burnt {} Tgas", o.executor_id, o.gas_burnt.as_tgas());
    }
    assert!(outcome.is_success(), "{outcome:#?}");

    for id in [first, first + 1] {
        let p: Value = e.dao.view("get_proposal").args_json(json!({ "id": id })).await?.json()?;
        assert_eq!(p["status"], "Approved", "{p}");
    }
    // `Approved` says nothing about the factory call: only the Guard being there does.
    let listed = e.guards_of(e.dao.id().as_str()).await?;
    assert_eq!((listed[0]["guard_id"].as_str(), listed[0]["ready"].as_bool()), (Some(guard.as_str()), Some(true)), "{listed}");
    let keys = e.worker.view_access_keys(&ids[0].parse()?).await?;
    assert_eq!(keys.len(), 1, "the agent account holds exactly its one key: {keys:?}");
    let after: Value = e.dao.view("get_policy").await?.json()?;
    assert!(after["roles"].as_array().unwrap().iter().any(|r| r["name"] == "agent-guard" && r["kind"]["Group"][0] == guard.as_str()), "{after}");
    Ok(())
}

/// The Guard wasm plus one empty custom section: still valid, but a different hash and length.
fn guard_wasm_v2() -> anyhow::Result<Vec<u8>> {
    let mut code = std::fs::read(GUARD_WASM)?;
    code.extend([0x00, 0x05, 0x04, b'm', b'a', b'r', b'k']);
    Ok(code)
}

fn borsh_bytes(code: &[u8]) -> Vec<u8> {
    let mut args = (code.len() as u32).to_le_bytes().to_vec();
    args.extend(code);
    args
}

// GĐ31 D1. The unit test cannot see `#[private]` (the wasm entry point enforces it), so the caller check is proved here.
#[tokio::test]
async fn only_the_factory_account_can_replace_the_guard_code() -> anyhow::Result<()> {
    // The factory is the code source a DAO votes an `upgrade` against: if anyone else could swap the bytes, an
    // approved hash would suddenly name a Guard the DAO never saw.
    let e = setup().await?;
    let v2 = guard_wasm_v2()?;
    let before: String = e.factory.view("get_code_hash").await?.json()?;
    for who in [&e.stranger, &e.council, &e.agent] {
        let outcome = who.call(e.factory.id(), "set_guard_code").args(borsh_bytes(&v2)).max_gas().transact().await?;
        assert!(outcome.is_failure(), "{} must not replace the code", who.id());
    }
    // The DAO account itself, through a proposal, is another caller too.
    let kind = json!({ "FunctionCall": { "receiver_id": e.factory.id(), "actions": [{
        "method_name": "set_guard_code", "args": STANDARD.encode(&v2), "deposit": "0",
        "gas": Gas::from_tgas(50).as_gas().to_string() }]}});
    let refused = e.council_passes(kind).await.expect_err("the DAO's call must fail");
    assert!(format!("{refused:?}").contains("is private"), "{refused:?}");
    assert_eq!(e.factory.view("get_code_hash").await?.json::<String>()?, before, "the hash must not move");
    assert_eq!(e.factory.view("get_guard_code").await?.result, std::fs::read(GUARD_WASM)?, "nor the bytes");
    Ok(())
}

#[tokio::test]
async fn after_set_guard_code_the_hash_the_bytes_and_the_next_guard_follow_the_new_code() -> anyhow::Result<()> {
    let e = setup().await?;
    let v2 = guard_wasm_v2()?;
    let old_hash: String = e.factory.view("get_code_hash").await?.json()?;

    // A Guard made before keeps the old code.
    assert_eq!(e.dao_creates("early", NearToken::from_near(5)).await?, "Approved");
    let early = e.worker.view_account(&e.guard_id("early").parse()?).await?;
    assert_eq!(local_hash(&early.contract_state), old_hash);

    e.factory.as_account().call(e.factory.id(), "set_guard_code").args(borsh_bytes(&v2)).max_gas().transact().await?.into_result()?;
    let new_hash: String = e.factory.view("get_code_hash").await?.json()?;
    assert_ne!(new_hash, old_hash);
    assert_eq!(e.factory.view("get_guard_code").await?.result, v2, "the bytes an `upgrade` hashes");
    let meta: Value = e.factory.view("kd_factory_metadata").await?.json()?;
    assert_eq!(meta["guard_code_hash"], new_hash, "{meta}");

    // The next Guard runs the new code; the early one is not touched.
    assert_eq!(e.dao_creates("late", NearToken::from_near(5)).await?, "Approved");
    let late = e.worker.view_account(&e.guard_id("late").parse()?).await?;
    assert_eq!(local_hash(&late.contract_state), new_hash);
    let early = e.worker.view_account(&e.guard_id("early").parse()?).await?;
    assert_eq!(local_hash(&early.contract_state), old_hash);
    Ok(())
}

fn local_hash(state: &near_workspaces::ContractState) -> String {
    match state {
        near_workspaces::ContractState::LocalHash(h) => h.to_string(),
        other => panic!("expected a deployed contract, got {other:?}"),
    }
}

// #81 spike: NEP-591. The factory publishes the Guard code once as a global contract by hash; a Guard made after
// that points at it, locks a few bytes instead of the whole wasm, and still pays Auto and holds Pending.
#[tokio::test]
async fn after_a_global_publish_a_guard_uses_the_code_by_hash_and_locks_only_a_few_bytes() -> anyhow::Result<()> {
    let e = setup().await?;
    let code_len = std::fs::read(GUARD_WASM)?.len() as u128;
    let hash: String = e.factory.view("get_code_hash").await?.json()?;
    assert_eq!(e.dao_creates("copy", NearToken::from_near(2)).await?, "Approved");
    let copy = e.worker.view_account(&e.guard_id("copy").parse()?).await?;

    // The publish burns 10x the storage price of the code; the factory account pays it.
    let burn_room = NearToken::from_near(code_len * 10 / 100_000 + 5);
    e.worker.root_account()?.transfer_near(e.factory.id(), burn_room).await?.into_result()?;
    let before = e.factory.view_account().await?.balance.as_yoctonear();
    let published: bool =
        e.factory.as_account().call(e.factory.id(), "publish_guard_code_global").max_gas().transact().await?.into_result()?.json()?;
    assert!(published, "the callback saw the publish succeed");
    let spent = before - e.factory.view_account().await?.balance.as_yoctonear();
    println!("COST global publish of {code_len} bytes = {:.4} NEAR burnt by the factory", spent as f64 / 1e24);
    let meta: Value = e.factory.view("kd_factory_metadata").await?.json()?;
    assert_eq!(meta["guard_code_global"], true, "{meta}");
    assert_eq!(e.code_storage().await?, 32 * 10u128.pow(19), "the dashboard's deposit drops with it");

    assert_eq!(e.dao_creates("acme", NearToken::from_near(2)).await?, "Approved");
    let gid: near_workspaces::AccountId = e.guard_id("acme").parse()?;
    let global = e.worker.view_account(&gid).await?;
    match &global.contract_state {
        near_workspaces::ContractState::GlobalHash(h) => assert_eq!(h.to_string(), hash, "the code the DAO can check"),
        other => panic!("expected a global contract by hash, got {other:?}"),
    }
    println!(
        "COST guard storage: own copy {} bytes ({:.4} NEAR locked), global {} bytes ({:.4} NEAR locked)",
        copy.storage_usage,
        copy.storage_usage as f64 / 1e5,
        global.storage_usage,
        global.storage_usage as f64 / 1e5
    );
    assert!(copy.storage_usage - global.storage_usage >= code_len as u64 - 100, "the Guard holds no copy of the code");
    assert!(e.worker.view_access_keys(&gid).await?.is_empty(), "still locked from birth");
    let config: Value = e.factory.as_account().view(&gid, "get_config").await?.json()?;
    assert_eq!(config["dao_id"], e.dao.id().as_str());

    assert_eq!(e.dao_adds_role(gid.as_str()).await?, "Approved");
    e.worker.root_account()?.transfer_near(e.dao.id(), NearToken::from_near(5)).await?.into_result()?;
    let request = |id: &'static str, to: &Account| {
        e.agent
            .call(&gid, "request_transfer")
            .args_json(json!({ "request_id": id, "receiver_id": to.id(), "amount": yocto(NearToken::from_millinear(100)), "memo": "global" }))
            .gas(REQUEST_GAS)
            .transact()
    };
    let auto: Value = request("auto-0001", &e.receiver).await?.into_result()?.json()?;
    assert_eq!(auto["status"], "AutoApproved", "{auto}");
    let pending: Value = request("pend-0001", &e.stranger).await?.into_result()?.json()?;
    assert_eq!(pending["status"], "Pending", "{pending}");
    Ok(())
}

// The live factory (`keydoctor-guards-v2.testnet`) already has Guards. It must take the global-contract code in place,
// as `factory-update.sh` redeploys it: same state, no init. Needs the factory wasm built from before that change
// (commit 49095c9) in KD_OLD_FACTORY_WASM; without it the test says so and passes.
#[tokio::test]
async fn a_factory_built_before_global_contracts_upgrades_in_place_and_keeps_its_guards() -> anyhow::Result<()> {
    let Ok(old_path) = std::env::var("KD_OLD_FACTORY_WASM") else {
        println!("SKIP set KD_OLD_FACTORY_WASM to the factory wasm built from 49095c9");
        return Ok(());
    };
    let e = setup_with(&std::fs::read(old_path)?).await?;
    let hash: String = e.factory.view("get_code_hash").await?.json()?;
    assert_eq!(e.dao_creates("early", NearToken::from_near(2)).await?, "Approved");

    let new_wasm = std::fs::read(FACTORY_WASM)?;
    e.factory.as_account().deploy(&new_wasm).await?.into_result()?;
    let meta: Value = e.factory.view("kd_factory_metadata").await?.json()?;
    assert_eq!((meta["guard_code_hash"].as_str(), meta["guards"].as_u64()), (Some(hash.as_str()), Some(1)), "{meta}");
    assert_eq!(meta["guard_code_global"], false, "nothing published yet");
    let listed = e.guards_of(e.dao.id().as_str()).await?;
    assert_eq!(listed[0]["guard_id"], e.guard_id("early"), "{listed}");

    let code_len = std::fs::read(GUARD_WASM)?.len() as u128;
    let burn_room = NearToken::from_near(code_len * 10 / 100_000 + 5);
    e.worker.root_account()?.transfer_near(e.factory.id(), burn_room).await?.into_result()?;
    let published: bool =
        e.factory.as_account().call(e.factory.id(), "publish_guard_code_global").max_gas().transact().await?.into_result()?.json()?;
    assert!(published);
    assert_eq!(e.dao_creates("late", NearToken::from_near(2)).await?, "Approved");
    let late = e.worker.view_account(&e.guard_id("late").parse()?).await?;
    assert!(matches!(late.contract_state, near_workspaces::ContractState::GlobalHash(h) if h.to_string() == hash));
    let early = e.worker.view_account(&e.guard_id("early").parse()?).await?;
    assert_eq!(local_hash(&early.contract_state), hash, "a Guard made before keeps its own copy");
    assert_eq!(e.guards_of(e.dao.id().as_str()).await?.as_array().unwrap().len(), 2);
    Ok(())
}
