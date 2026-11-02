// The factory in a local sandbox against the Sputnik v2 wasm testnet DAOs run. A DAO creates a Guard through a
// FunctionCall proposal, the council adds the `agent-guard` role, and the factory-made Guard pays Auto and holds
// Pending exactly like a hand-deployed one. Prints the deposit and gas the dashboard attaches (`-- --nocapture`,
// lines starting with `COST`).
// Needs both wasm files: `cargo near build non-reproducible-wasm --no-abi` in contracts/guard and here
// (`pnpm test:guard` does it).
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const SPUTNIK_WASM: &str = "../guard/tests/res/sputnik_dao_v2.wasm";
const GUARD_WASM: &str = "../guard/target/near/kd_guard.wasm";
const FACTORY_WASM: &str = "target/near/kd_guard_factory.wasm";
// What the dashboard puts on the proposal's FunctionCall action.
const CREATE_GAS: Gas = Gas::from_tgas(150);
const REQUEST_GAS: Gas = Gas::from_tgas(200);

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
/// pays the global publish (0.0001 NEAR per byte of Guard code, about 25 NEAR) from its own balance.
async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact();
    let council = sub("council", 20).await?.into_result()?;
    let agent = sub("agent", 5).await?.into_result()?;
    let receiver = sub("receiver", 1).await?.into_result()?;
    let stranger = sub("stranger", 20).await?.into_result()?;
    let dao = sub("dao", 50).await?.into_result()?;
    let factory = sub("factory", 40).await?.into_result()?;

    let dao = dao.deploy(&std::fs::read(SPUTNIK_WASM)?).await?.into_result()?;
    dao.call("new")
        .args_json(json!({ "config": { "name": "kd-factory", "purpose": "factory test", "metadata": "" }, "policy": [council.id()] }))
        .transact()
        .await?
        .into_result()?;
    let policy: Value = dao.view("get_policy").await?.json()?;
    let bond = policy["proposal_bond"].as_str().unwrap().parse::<u128>()?;

    let factory = factory.deploy(&std::fs::read(FACTORY_WASM).expect("build the factory wasm first")).await?.into_result()?;
    let code = std::fs::read(GUARD_WASM).expect("build the Guard wasm first (contracts/guard)");
    // `new` takes the code as borsh `Vec<u8>`: u32 length, then the bytes.
    let mut args = (code.len() as u32).to_le_bytes().to_vec();
    args.extend(code);
    let before = factory.view_account().await?.balance;
    factory.call("new").args(args).max_gas().transact().await?.into_result()?;
    let spent = before.as_yoctonear() - factory.view_account().await?.balance.as_yoctonear();
    println!("COST factory new (global publish) spent={:.3} NEAR", spent as f64 / 1e24);

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

    /// P1 of the dashboard flow: the DAO calls `factory.create` with `deposit` as the Guard's funding.
    async fn dao_creates(&self, name: &str, deposit: NearToken) -> anyhow::Result<String> {
        let kind = json!({ "FunctionCall": { "receiver_id": self.factory.id(), "actions": [{
            "method_name": "create",
            "args": STANDARD.encode(self.create_args(name).to_string()),
            "deposit": yocto(deposit),
            "gas": CREATE_GAS.as_gas().to_string(),
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
    println!("COST guard balance after create with {funding} deposit = {:.4} NEAR", balance as f64 / 1e24);
    assert!(balance > funding.as_yoctonear() * 99 / 100, "the deposit, minus the registry record, funds the Guard");

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
