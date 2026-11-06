// The Guard in a local sandbox, against the Sputnik v2 wasm that testnet DAOs run (tests/res, plan.md D6).
// GĐ15 proved a contract member with the `agent-guard` role can propose and approve a transfer alone; GĐ17 runs
// every §13.6 case against the full contract and prints the gas and key allowance the README quotes
// (`cargo test --test sandbox -- --nocapture`, lines starting with `GAS`).
// Needs the Guard and factory wasm: `cargo near build non-reproducible-wasm --no-abi` in each first (`pnpm test:guard` does it).
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const SPUTNIK_WASM: &str = "tests/res/sputnik_dao_v2.wasm";
const GUARD_WASM: &str = "target/near/kd_guard.wasm";
const FACTORY_WASM: &str = "../guard-factory/target/near/kd_guard_factory.wasm";
// What the dashboard puts on the `upgrade` proposal's FunctionCall action.
const UPGRADE_GAS: Gas = Gas::from_tgas(150);
// The gas the README tells agents to attach to `request_transfer`; the tests prove it is enough for both paths.
const REQUEST_GAS: Gas = Gas::from_tgas(200);

struct Env {
    worker: Worker<near_workspaces::network::Sandbox>,
    dao: Contract,
    guard: Contract,
    council: Account,
    agent: Account,
    receiver: Account,
    stranger: Account,
    guardian: Account,
    bond: u128,
}

fn yocto(t: NearToken) -> String {
    t.as_yoctonear().to_string()
}

/// A Sputnik DAO with one council member, a Guard with one agent, one whitelisted receiver and one guardian, and
/// the `agent-guard` role installed by a council-approved policy change. Limits: 1 NEAR per tx, 2 NEAR per day,
/// 3 pending per agent, 1 NEAR reserve.
async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact();
    let council = sub("council", 20).await?.into_result()?;
    let agent = sub("agent", 5).await?.into_result()?;
    let receiver = sub("receiver", 1).await?.into_result()?;
    let stranger = sub("stranger", 5).await?.into_result()?;
    let guardian = sub("guardian", 5).await?.into_result()?;
    let guard = sub("guard", 20).await?.into_result()?;
    let dao = sub("dao", 30).await?.into_result()?;

    let dao = dao.deploy(&std::fs::read(SPUTNIK_WASM)?).await?.into_result()?;
    dao.call("new")
        .args_json(json!({ "config": { "name": "kd-guard", "purpose": "GD17", "metadata": "" }, "policy": [council.id()] }))
        .transact()
        .await?
        .into_result()?;
    let policy: Value = dao.view("get_policy").await?.json()?;
    let bond = policy["proposal_bond"].as_str().unwrap().parse::<u128>()?;

    let guard_wasm = std::fs::read(GUARD_WASM).expect("build the Guard wasm first: cargo near build non-reproducible-wasm --no-abi");
    let guard = guard.deploy(&guard_wasm).await?.into_result()?;
    guard
        .call("new")
        .args_json(json!({
            "dao_id": dao.id(),
            "policy": {
                "max_per_tx": yocto(NearToken::from_near(1)),
                "max_per_day": yocto(NearToken::from_near(2)),
                "max_pending_per_agent": 3,
                "min_reserve": yocto(NearToken::from_near(1)),
            },
            "agents": [{ "account_id": agent.id(), "label": "payroll bot" }],
            "whitelist": [{ "account_id": receiver.id(), "label": "vendor", "max_per_tx": null }],
            "guardians": [guardian.id()],
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let config: Value = guard.view("get_config").await?.json()?;
    assert_eq!(config["proposal_bond"], bond.to_string(), "init must cache the DAO bond: {config}");

    // G-Q1: testnet factory DAOs reject `ChangePolicyAddOrUpdateRole`, so the role goes in through `ChangePolicy`
    // with the whole current policy. Same JSON as scripts/guard-setup/spike.sh.
    let mut new_policy = policy.clone();
    new_policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "agent-guard",
        "kind": { "Group": [guard.id()] },
        "permissions": ["transfer:AddProposal", "transfer:VoteApprove"],
        "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" } }
    }));
    let env = Env { worker, dao, guard, council, agent, receiver, stranger, guardian, bond };
    let status = env.council_passes(json!({ "ChangePolicy": { "policy": new_policy } })).await?;
    assert_eq!(status, "Approved", "the council must accept the role proposal");
    Ok(env)
}

impl Env {
    /// The council proposes `kind` and votes it through; returns the proposal's status afterwards.
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
        self.vote(id, "VoteApprove").await?;
        Ok(self.proposal(id).await?["status"].as_str().unwrap().to_string())
    }

    /// A DAO `FunctionCall` proposal on the Guard, the only way to reach its DAO-only methods.
    async fn dao_calls_guard(&self, method: &str, args: Value, deposit: NearToken) -> anyhow::Result<String> {
        let kind = json!({ "FunctionCall": { "receiver_id": self.guard.id(), "actions": [{
            "method_name": method,
            "args": STANDARD.encode(args.to_string()),
            "deposit": yocto(deposit),
            "gas": Gas::from_tgas(50).as_gas().to_string(),
        }]}});
        self.council_passes(kind).await
    }

    async fn vote(&self, id: u64, action: &str) -> anyhow::Result<()> {
        let kind = self.proposal(id).await?["kind"].clone();
        self.council
            .call(self.dao.id(), "act_proposal")
            .args_json(json!({ "id": id, "action": action, "proposal": kind }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn proposal(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self.dao.view("get_proposal").args_json(json!({ "id": id })).await?.json()?)
    }

    async fn last_proposal_id(&self) -> anyhow::Result<u64> {
        Ok(self.dao.view("get_last_proposal_id").await?.json()?)
    }

    async fn request_as(&self, who: &Account, request_id: &str, to: &Account, amount: NearToken) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.guard.id(), "request_transfer")
            .args_json(json!({ "request_id": request_id, "receiver_id": to.id(), "amount": yocto(amount), "memo": "GD17" }))
            .gas(REQUEST_GAS)
            .transact()
            .await?)
    }

    /// The agent's request; panics if the Guard refuses it.
    async fn request(&self, request_id: &str, to: &Account, amount: NearToken) -> anyhow::Result<Value> {
        Ok(self.request_as(&self.agent, request_id, to, amount).await?.into_result()?.json()?)
    }

    async fn sync(&self, request_id: &str) -> anyhow::Result<Value> {
        Ok(self
            .agent
            .call(self.guard.id(), "sync_request")
            .args_json(json!({ "request_id": request_id }))
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json()?)
    }

    async fn pending(&self) -> anyhow::Result<u64> {
        let agents: Value = self.guard.view("get_agents").await?.json()?;
        Ok(agents[0]["pending"].as_u64().unwrap())
    }

    async fn balance(&self, account: &Account) -> anyhow::Result<u128> {
        Ok(account.view_account().await?.balance.as_yoctonear())
    }
}

/// The transaction failed with the Guard's error code `code`.
fn fails_with(outcome: ExecutionFinalResult, code: &str) {
    let err = format!("{:?}", outcome.into_result().expect_err(&format!("expected {code}, but it succeeded")));
    assert!(err.contains(code), "expected {code}, got {err}");
}

#[tokio::test]
async fn auto_pays_the_whitelisted_receiver_in_the_same_transaction() -> anyhow::Result<()> {
    let e = setup().await?;
    let amount = NearToken::from_millinear(100);
    let before = e.balance(&e.receiver).await?;
    let outcome = e.request_as(&e.agent, "auto-0001", &e.receiver, amount).await?;
    println!("GAS auto request_transfer burnt={:.1} Tgas", outcome.total_gas_burnt.as_gas() as f64 / 1e12);
    let record: Value = outcome.into_result()?.json()?;
    assert_eq!(record["status"], "AutoApproved", "{record}");

    let proposal = e.proposal(record["proposal_id"].as_u64().unwrap()).await?;
    assert_eq!(proposal["status"], "Approved", "the Guard's own vote must pass the transfer: {proposal}");
    assert_eq!(proposal["proposer"], e.guard.id().as_str());
    assert!(proposal["description"].as_str().unwrap().starts_with("[KD-GUARD] request=auto-0001 "));
    assert_eq!(e.balance(&e.receiver).await? - before, amount.as_yoctonear(), "the NEAR must arrive in the same tx");

    assert_eq!(e.sync("auto-0001").await?["status"], "Executed");
    let window: Value = e.guard.view("get_window").await?.json()?;
    assert_eq!(window["spent_in_window"], yocto(amount), "an Auto payment counts toward the daily cap: {window}");
    let agents: Value = e.guard.view("get_agents").await?.json()?;
    assert_eq!(agents[0]["spent_24h"], yocto(amount), "the owner sees which agent spent it: {agents}");
    Ok(())
}

#[tokio::test]
async fn pending_does_not_pay_until_the_council_approves() -> anyhow::Result<()> {
    let e = setup().await?;
    let amount = NearToken::from_millinear(100);
    let before = e.balance(&e.stranger).await?;
    let outcome = e.request_as(&e.agent, "pend-0001", &e.stranger, amount).await?;
    println!("GAS pending request_transfer burnt={:.1} Tgas", outcome.total_gas_burnt.as_gas() as f64 / 1e12);
    let record: Value = outcome.into_result()?.json()?;
    assert_eq!((record["status"].as_str(), record["reasons"][0].as_str()), (Some("Pending"), Some("NOT_WHITELISTED")));

    let id = record["proposal_id"].as_u64().unwrap();
    assert_eq!(e.proposal(id).await?["status"], "InProgress", "the Guard must not vote on a Pending request");
    assert_eq!(e.balance(&e.stranger).await?, before, "no NEAR moves before the council votes");
    assert_eq!(e.sync("pend-0001").await?["status"], "Pending", "sync keeps an open proposal Pending");

    e.vote(id, "VoteApprove").await?;
    assert_eq!(e.balance(&e.stranger).await? - before, amount.as_yoctonear());
    assert_eq!(e.sync("pend-0001").await?["status"], "Executed");
    assert_eq!(e.pending().await?, 0, "the closed request frees the agent's pending slot");
    Ok(())
}

#[tokio::test]
async fn council_reject_refunds_the_bond_to_the_guard() -> anyhow::Result<()> {
    // The Guard pays every bond; if a rejection kept it, each refused request would drain the Guard.
    let e = setup().await?;
    let record = e.request("pend-0002", &e.stranger, NearToken::from_near(5)).await?;
    assert_eq!(record["status"], "Pending");
    let before = e.balance(e.guard.as_account()).await?;
    e.vote(record["proposal_id"].as_u64().unwrap(), "VoteReject").await?;
    assert!(e.balance(e.guard.as_account()).await? >= before + e.bond, "Sputnik must return the bond on Reject");
    assert_eq!(e.sync("pend-0002").await?["status"], "Rejected");
    assert_eq!(e.pending().await?, 0);
    Ok(())
}

#[tokio::test]
async fn duplicate_request_id_creates_no_second_proposal() -> anyhow::Result<()> {
    // An agent that retries after a timeout must not pay twice.
    let e = setup().await?;
    e.request("dup-00001", &e.receiver, NearToken::from_millinear(100)).await?;
    let last = e.last_proposal_id().await?;
    fails_with(e.request_as(&e.agent, "dup-00001", &e.receiver, NearToken::from_millinear(100)).await?, "DUPLICATE_REQUEST");
    assert_eq!(e.last_proposal_id().await?, last);
    Ok(())
}

#[tokio::test]
async fn pending_cap_stops_a_proposal_flood() -> anyhow::Result<()> {
    // A looping agent cannot lock more than max_pending_per_agent bonds in open proposals.
    let e = setup().await?;
    for i in 0..3 {
        assert_eq!(e.request(&format!("flood-000{i}"), &e.stranger, NearToken::from_millinear(10)).await?["status"], "Pending");
    }
    let last = e.last_proposal_id().await?;
    fails_with(e.request_as(&e.agent, "flood-0009", &e.stranger, NearToken::from_millinear(10)).await?, "TOO_MANY_PENDING");
    assert_eq!(e.last_proposal_id().await?, last);
    Ok(())
}

#[tokio::test]
async fn strangers_cannot_request_configure_or_pause() -> anyhow::Result<()> {
    let e = setup().await?;
    fails_with(e.request_as(&e.stranger, "strange-01", &e.receiver, NearToken::from_millinear(10)).await?, "UNKNOWN_AGENT");
    let policy = json!({ "policy": { "max_per_tx": yocto(NearToken::from_near(1000)), "max_per_day": yocto(NearToken::from_near(1000)), "max_pending_per_agent": 50, "min_reserve": "0" } });
    fails_with(e.stranger.call(e.guard.id(), "set_policy").args_json(policy).transact().await?, "ONLY_DAO");
    fails_with(e.stranger.call(e.guard.id(), "pause").transact().await?, "NOT_GUARDIAN");
    Ok(())
}

#[tokio::test]
async fn only_a_dao_proposal_changes_the_config() -> anyhow::Result<()> {
    // Even a council member cannot widen the Guard alone: config changes go through a DAO vote.
    let e = setup().await?;
    let args = json!({ "account_id": e.stranger.id(), "label": "new vendor", "max_per_tx": null });
    let direct = e.council.call(e.guard.id(), "add_whitelist").args_json(&args).deposit(NearToken::from_millinear(10)).transact().await?;
    fails_with(direct, "ONLY_DAO");

    let status = e.dao_calls_guard("add_whitelist", args, NearToken::from_millinear(10)).await?;
    assert_eq!(status, "Approved");
    let whitelist: Value = e.guard.view("get_whitelist").await?.json()?;
    assert!(whitelist.as_array().unwrap().iter().any(|w| w["account_id"] == e.stranger.id().as_str()), "{whitelist}");
    // The new entry takes effect: the same request is now Auto.
    assert_eq!(e.request("after-wl-01", &e.stranger, NearToken::from_millinear(10)).await?["status"], "AutoApproved");
    Ok(())
}

#[tokio::test]
async fn guardian_pause_blocks_requests_until_the_dao_unpauses() -> anyhow::Result<()> {
    let e = setup().await?;
    e.guardian.call(e.guard.id(), "pause").transact().await?.into_result()?;
    fails_with(e.request_as(&e.agent, "paused-001", &e.receiver, NearToken::from_millinear(10)).await?, "PAUSED");
    // A guardian can stop the Guard but not restart it.
    fails_with(e.guardian.call(e.guard.id(), "unpause").transact().await?, "ONLY_DAO");

    assert_eq!(e.dao_calls_guard("unpause", json!({}), NearToken::from_yoctonear(0)).await?, "Approved");
    assert_eq!(e.request("paused-002", &e.receiver, NearToken::from_millinear(10)).await?["status"], "AutoApproved");
    Ok(())
}

#[tokio::test]
async fn function_call_key_allowance_per_request() -> anyhow::Result<()> {
    // The agent signs with a function-call key limited to the Guard (plan.md D3). NEAR checks the allowance
    // against the attached gas at a pessimistic price before the call runs, then refunds the unused gas to it
    // a few blocks later. The README quotes both numbers, so both are asserted here.
    let e = &setup().await?;
    let add_key = |allowance: NearToken| async move {
        let sk = SecretKey::from_random(KeyType::ED25519);
        let methods = ["request_transfer", "sync_request"];
        e.agent
            .batch(e.agent.id())
            .add_key(sk.public_key(), AccessKey::function_call_access(e.guard.id(), &methods, Some(allowance)))
            .transact()
            .await?
            .into_result()?;
        anyhow::Ok(sk)
    };
    let left = |sk: SecretKey| async move {
        let key = e.worker.view_access_key(e.agent.id(), &sk.public_key()).await?;
        anyhow::Ok(match key.permission {
            AccessKeyPermission::FunctionCall(p) => p.allowance.unwrap().as_yoctonear(),
            AccessKeyPermission::FullAccess => unreachable!("function-call key expected"),
        })
    };

    // Upfront: 0.2 NEAR left is not enough to attach 200 Tgas, 0.25 NEAR (the wallet default) is.
    let low = Account::from_secret_key(e.agent.id().clone(), add_key(NearToken::from_millinear(200)).await?, &e.worker);
    assert!(e.request_as(&low, "key-low-001", &e.receiver, NearToken::from_millinear(10)).await.is_err(), "0.2 NEAR must be refused at 200 Tgas");

    // Net: what one request really costs the allowance once the refund lands.
    let sk = add_key(NearToken::from_near(1)).await?;
    let agent_key = Account::from_secret_key(e.agent.id().clone(), sk.clone(), &e.worker);
    for (request_id, to, status) in [("key-auto-01", &e.receiver, "AutoApproved"), ("key-pend-01", &e.stranger, "Pending")] {
        let before = left(sk.clone()).await?;
        let record: Value = e.request_as(&agent_key, request_id, to, NearToken::from_millinear(10)).await?.into_result()?.json()?;
        assert_eq!(record["status"], status);
        e.worker.fast_forward(5).await?;
        let spent = before - left(sk.clone()).await?;
        println!("GAS {status} via function-call key, {} Tgas attached: allowance -{:.2} mNEAR net", REQUEST_GAS.as_tgas(), spent as f64 / 1e21);
        assert!(spent < NearToken::from_millinear(5).as_yoctonear(), "one request must cost the allowance under 5 mNEAR net");
    }
    let mid = Account::from_secret_key(e.agent.id().clone(), add_key(NearToken::from_millinear(250)).await?, &e.worker);
    e.request_as(&mid, "key-mid-001", &e.receiver, NearToken::from_millinear(10)).await?.into_result()?;

    // The key reaches nothing outside the two methods.
    assert!(agent_key.call(e.guard.id(), "pause").transact().await.is_err(), "the key must be limited to request_transfer and sync_request");
    Ok(())
}

// B-Q7 (docs/final-idea.md §11.10.5): the Sputnik code testnet DAOs run does not compare `proposal` with proposal
// `id`. A one-signature "add_proposal + act_proposal(guessed id)" batch can therefore approve an agent's proposal
// that landed first, so the dashboard must read the real id and vote in a second transaction.
#[tokio::test]
async fn installed_sputnik_ignores_the_proposal_argument_of_act_proposal() -> anyhow::Result<()> {
    let env = setup().await?;
    let real = json!({ "Transfer": { "token_id": "", "receiver_id": env.receiver.id(), "amount": "1", "msg": null } });
    let other = json!({ "Transfer": { "token_id": "", "receiver_id": env.stranger.id(), "amount": "2", "msg": null } });
    let id: u64 = env
        .council
        .call(env.dao.id(), "add_proposal")
        .args_json(json!({ "proposal": { "description": "real", "kind": real } }))
        .deposit(NearToken::from_yoctonear(env.bond))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;

    let outcome = env
        .council
        .call(env.dao.id(), "act_proposal")
        .args_json(json!({ "id": id, "action": "VoteApprove", "proposal": other }))
        .max_gas()
        .transact()
        .await?;

    assert!(outcome.is_success(), "this build started checking `proposal`: B-Q7 changes, one-signature batches may be safe");
    assert_eq!(env.proposal(id).await?["status"], "Approved");
    Ok(())
}

// ---- agent accounts (§11.10.2): the Guard creates the account, so the key's scope is fixed by the contract

impl Env {
    fn guard_sub(&self, name: &str) -> near_workspaces::AccountId {
        format!("{name}.{}", self.guard.id()).parse().unwrap()
    }

    /// The account and key the dashboard hands to the owner: created by a DAO proposal, signed with `SecretKey`.
    async fn dao_adds_keyed_agent(&self, name: &str) -> anyhow::Result<(Account, String)> {
        let sk = SecretKey::from_random(KeyType::ED25519);
        let id = self.guard_sub(name);
        let args = json!({ "account_id": id, "label": name, "public_key": sk.public_key().to_string() });
        let status = self.dao_calls_guard("add_agent", args, NearToken::from_near(1)).await?;
        Ok((Account::from_secret_key(id, sk, &self.worker), status))
    }

    async fn agent_ids(&self) -> anyhow::Result<Vec<String>> {
        let agents: Value = self.guard.view("get_agents").await?.json()?;
        Ok(agents.as_array().unwrap().iter().map(|a| a["account_id"].as_str().unwrap().to_string()).collect())
    }

    /// The chain's record of the deployed code, whatever that code claims about itself.
    async fn code(&self) -> anyhow::Result<String> {
        Ok(format!("{:?}", self.guard.view_account().await?.contract_state))
    }

    async fn version(&self) -> anyhow::Result<String> {
        let info: Value = self.guard.view("kd_guard_info").await?.json()?;
        Ok(info["version"].as_str().unwrap().to_string())
    }

    /// A factory holding `code`: what a new Guard release ships as, and the source `upgrade` reads from.
    async fn code_source(&self, name: &str, code: &[u8]) -> anyhow::Result<(Contract, String)> {
        let root = self.worker.root_account()?;
        let account = root.create_subaccount(name).initial_balance(NearToken::from_near(6)).transact().await?.into_result()?;
        let factory_wasm = std::fs::read(FACTORY_WASM).expect("build the factory wasm first (contracts/guard-factory)");
        let factory = account.deploy(&factory_wasm).await?.into_result()?;
        let mut args = (code.len() as u32).to_le_bytes().to_vec();
        args.extend(code);
        factory.call("new").args(args).max_gas().transact().await?.into_result()?;
        let hash: String = factory.view("get_code_hash").await?.json()?;
        Ok((factory, hash))
    }

    /// The DAO's `FunctionCall` proposal, approved at the gas the dashboard attaches; the proposal's status after.
    async fn dao_upgrades_guard(&self, source: &str, hash: &str) -> anyhow::Result<(String, f64)> {
        let kind = json!({ "FunctionCall": { "receiver_id": self.guard.id(), "actions": [{
            "method_name": "upgrade",
            "args": STANDARD.encode(json!({ "code_source": source, "code_hash": hash }).to_string()),
            "deposit": "0",
            "gas": UPGRADE_GAS.as_gas().to_string(),
        }]}});
        let id: u64 = self
            .council
            .call(self.dao.id(), "add_proposal")
            .args_json(json!({ "proposal": { "description": "upgrade the Guard", "kind": kind.clone() } }))
            .deposit(NearToken::from_yoctonear(self.bond))
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json()?;
        let outcome = self
            .council
            .call(self.dao.id(), "act_proposal")
            .args_json(json!({ "id": id, "action": "VoteApprove", "proposal": kind }))
            .max_gas()
            .transact()
            .await?;
        let burnt = outcome.total_gas_burnt.as_gas() as f64 / 1e12;
        Ok((self.proposal(id).await?["status"].as_str().unwrap().to_string(), burnt))
    }
}

/// The Guard's own wasm with another version, so a test can see which code answers.
fn guard_wasm_with_version(version: &[u8; 5]) -> Vec<u8> {
    let mut code = std::fs::read(GUARD_WASM).unwrap();
    let hits: Vec<usize> = code.windows(5).enumerate().filter(|(_, w)| w == b"1.1.0").map(|(i, _)| i).collect();
    assert!(!hits.is_empty(), "the version string must be in the wasm");
    for i in hits {
        code[i..i + 5].copy_from_slice(version);
    }
    code
}

#[tokio::test]
async fn a_dao_made_agent_key_reaches_only_the_two_guard_methods() -> anyhow::Result<()> {
    let e = setup().await?;
    let (agent, status) = e.dao_adds_keyed_agent("a1").await?;
    assert_eq!(status, "Approved");

    let keys = e.worker.view_access_keys(agent.id()).await?;
    assert_eq!(keys.len(), 1, "no full-access key may exist on an agent account: {keys:?}");
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.receiver_id, e.guard.id().as_str());
            assert_eq!(p.method_names, ["request_transfer", "sync_request"]);
            assert!(p.allowance.is_none(), "the account balance is the cap");
        }
        AccessKeyPermission::FullAccess => panic!("the key must be a function-call key"),
    }
    let funded = e.balance(&agent).await?;
    assert_eq!(funded, NearToken::from_millinear(500).as_yoctonear(), "the account starts with the gas fund only");

    let outcome = e.request_as(&agent, "keyed-0001", &e.receiver, NearToken::from_millinear(10)).await?;
    let record: Value = outcome.into_result()?.json()?;
    assert_eq!(record["status"], "AutoApproved", "the new account must work as an agent at once: {record}");
    e.worker.fast_forward(5).await?;
    println!("COST agent account: one Auto request costs {:.2} mNEAR of the fund", (funded - e.balance(&agent).await?) as f64 / 1e21);

    // A stolen key: the Guard's other methods and every other contract are refused before any code runs.
    assert!(agent.call(e.guard.id(), "pause").transact().await.is_err(), "the key must not reach pause");
    assert!(agent.call(e.dao.id(), "add_proposal").transact().await.is_err(), "the key must not reach the DAO");
    assert!(agent.batch(e.stranger.id()).transfer(NearToken::from_near(1)).transact().await.is_err(), "the key must not move the fund");
    Ok(())
}

#[tokio::test]
async fn reusing_the_name_of_a_removed_agent_leaves_no_agent_and_returns_the_fund() -> anyhow::Result<()> {
    // The old account and its key still exist, so an agent registered here would be run by whoever held that key.
    let e = setup().await?;
    let (agent, _) = e.dao_adds_keyed_agent("a1").await?;
    assert_eq!(e.dao_calls_guard("remove_agent", json!({ "account_id": agent.id() }), NearToken::from_yoctonear(0)).await?, "Approved");

    let dao_before = e.dao.view_account().await?.balance.as_yoctonear();
    let guard_before = e.guard.view_account().await?.balance.as_yoctonear();
    let (_, status) = e.dao_adds_keyed_agent("a1").await?;
    assert_eq!(status, "Approved", "Sputnik does not see the failure, so the Guard has to clean up");
    e.worker.fast_forward(5).await?; // the callback's refund is not part of the proposal's own result

    assert!(!e.agent_ids().await?.contains(&agent.id().to_string()), "the agent must not stay registered");
    let dao_after = e.dao.view_account().await?.balance.as_yoctonear();
    // Only the agent record's storage stays with the Guard, a few mNEAR; the 0.5 NEAR fund must not.
    let slack = NearToken::from_millinear(10).as_yoctonear();
    assert!(dao_after + slack >= dao_before, "the DAO must get its deposit back: {dao_before} -> {dao_after}");
    let guard_after = e.guard.view_account().await?.balance.as_yoctonear();
    assert!(guard_after + slack >= guard_before, "the Guard must not pay for the failure: {guard_before} -> {guard_after}");
    Ok(())
}

#[tokio::test]
async fn new_creates_ten_keyed_agent_accounts() -> anyhow::Result<()> {
    let e = setup().await?;
    let root = e.worker.root_account()?;
    let account = root.create_subaccount("guard2").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let guard = account.deploy(&std::fs::read(GUARD_WASM)?).await?.into_result()?;
    let ids: Vec<String> = (0..10).map(|i| format!("a{i}.{}", guard.id())).collect();
    let agents: Vec<Value> = ids
        .iter()
        .map(|id| json!({ "account_id": id, "label": "bot", "public_key": SecretKey::from_random(KeyType::ED25519).public_key().to_string() }))
        .collect();
    let outcome = guard
        .call("new")
        .args_json(json!({
            "dao_id": e.dao.id(),
            "policy": { "max_per_tx": "1", "max_per_day": "2", "max_pending_per_agent": 3, "min_reserve": "1" },
            "agents": agents, "whitelist": [], "guardians": [],
        }))
        .max_gas()
        .transact()
        .await?;
    println!("GAS new with 10 keyed agents burnt={:.1} Tgas", outcome.total_gas_burnt.as_gas() as f64 / 1e12);
    outcome.into_result()?;
    for id in &ids {
        let keys = e.worker.view_access_keys(&id.parse()?).await?;
        assert_eq!(keys.len(), 1, "{id} must exist with its one key");
    }
    Ok(())
}

// ---- upgrade (§11.5.12, ADR 0006, B-Q10): the path only a real Sputnik can prove

// Why `upgrade` is not reached through `UpgradeRemote`: the installed Sputnik keeps 10 Tgas after attaching the rest
// to the remote call, and copying the wasm costs more than that past about 150 KB. If this ever passes, B-Q10 and
// ADR 0006 can be reopened.
#[tokio::test]
async fn installed_sputnik_cannot_send_a_guard_sized_wasm_through_upgrade_remote() -> anyhow::Result<()> {
    let e = setup().await?;
    let code = std::fs::read(GUARD_WASM)?;
    let deposit = NearToken::from_yoctonear((code.len() as u128 + 32) * 10_000_000_000_000_000_000);
    let blob = e.council.call(e.dao.id(), "store_blob").args(code).deposit(deposit).max_gas().transact().await?;
    let hash: String = blob.into_result()?.json()?;
    let kind = json!({ "UpgradeRemote": { "receiver_id": e.guard.id(), "method_name": "upgrade", "hash": hash } });
    let id: u64 = e
        .council
        .call(e.dao.id(), "add_proposal")
        .args_json(json!({ "proposal": { "description": "upgrade", "kind": kind.clone() } }))
        .deposit(NearToken::from_yoctonear(e.bond))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let vote = e.council.call(e.dao.id(), "act_proposal").args_json(json!({ "id": id, "action": "VoteApprove", "proposal": kind })).max_gas().transact().await?;
    fails_with(vote, "Exceeded the prepaid gas");
    Ok(())
}

#[tokio::test]
async fn a_dao_upgrades_the_guard_and_every_record_survives() -> anyhow::Result<()> {
    let e = setup().await?;
    assert_eq!(e.version().await?, "1.1.0");
    let held = e.request("up-pend-01", &e.stranger, NearToken::from_millinear(100)).await?;
    assert_eq!(held["status"], "Pending");
    let config: Value = e.guard.view("get_config").await?.json()?;
    let code = e.code().await?;
    let keys = e.guard.view_access_keys().await?.len();

    let (source, hash) = e.code_source("release", &guard_wasm_with_version(b"9.9.9")).await?;
    let (status, burnt) = e.dao_upgrades_guard(source.id().as_str(), &hash).await?;
    println!("GAS upgrade through a DAO FunctionCall: burnt={burnt:.1} Tgas");
    assert_eq!(status, "Approved");

    assert_eq!(e.version().await?, "9.9.9", "the new code must answer");
    assert_ne!(e.code().await?, code);
    assert_eq!(e.guard.view("get_config").await?.json::<Value>()?, config, "policy and DAO must survive");
    assert_eq!(e.pending().await?, 1, "the agent's pending count must survive");
    assert_eq!(e.guard.view_access_keys().await?.len(), keys, "an upgrade adds no key to the Guard");

    // The request made under the old code still finishes under the new one.
    e.vote(held["proposal_id"].as_u64().unwrap(), "VoteApprove").await?;
    assert_eq!(e.sync("up-pend-01").await?["status"], "Executed");
    Ok(())
}

// The installed Sputnik attaches no callback to a `FunctionCall`, so `Approved` only says the call was sent. A failed
// upgrade changes nothing on the Guard and nothing on the proposal: the dashboard has to read the Guard's code hash back.
#[tokio::test]
async fn a_failed_upgrade_leaves_the_old_guard_and_the_proposal_cannot_show_it() -> anyhow::Result<()> {
    let e = setup().await?;
    let code = e.code().await?;
    let (source, hash) = e.code_source("release", &guard_wasm_with_version(b"9.9.9")).await?;
    let (junk, junk_hash) = e.code_source("junk", b"this is not wasm").await?;
    let wrong_hash = junk_hash.clone();

    for (who, what, hash) in [
        (source.id().as_str(), "code that is not the approved hash", wrong_hash.as_str()),
        (junk.id().as_str(), "bytes that are not wasm", junk_hash.as_str()),
        ("nobody.test.near", "a source that does not exist", hash.as_str()),
    ] {
        let (status, _) = e.dao_upgrades_guard(who, hash).await?;
        assert_eq!(status, "Approved", "{what}: if this becomes Failed, the dashboard can trust the status");
        assert_eq!(e.code().await?, code, "{what}: deploy and migrate are one receipt");
    }
    assert_eq!(e.request("after-bad-01", &e.receiver, NearToken::from_millinear(10)).await?["status"], "AutoApproved");
    Ok(())
}

#[tokio::test]
async fn nobody_outside_the_dao_reaches_upgrade_or_its_callbacks() -> anyhow::Result<()> {
    let e = setup().await?;
    let (source, hash) = e.code_source("release", &guard_wasm_with_version(b"6.6.6")).await?;
    let args = json!({ "code_source": source.id(), "code_hash": hash });
    for who in [&e.stranger, &e.agent, &e.guardian, &e.council] {
        fails_with(who.call(e.guard.id(), "upgrade").args_json(&args).max_gas().transact().await?, "ONLY_DAO");
    }
    let on_code = e.stranger.call(e.guard.id(), "on_code").args_json(json!({ "code_hash": hash })).max_gas().transact().await?;
    assert!(on_code.is_failure(), "on_code is private");
    let migrate = e.stranger.call(e.guard.id(), "migrate").max_gas().transact().await?;
    assert!(migrate.is_failure(), "migrate is private");
    assert_eq!(e.version().await?, "1.1.0");
    Ok(())
}

// §11.10.5: the reason an owner action takes two signatures. An agent's proposal can land between the owner's
// add_proposal and their vote; the vote must reach only the id the owner read back.
#[tokio::test]
async fn an_agent_proposal_inserted_before_the_owner_votes_stays_open() -> anyhow::Result<()> {
    let e = setup().await?;
    let kind = json!({ "Transfer": { "token_id": "", "receiver_id": e.receiver.id(), "amount": "1", "msg": null } });
    let owner: u64 = e
        .council
        .call(e.dao.id(), "add_proposal")
        .args_json(json!({ "proposal": { "description": "owner action", "kind": kind } }))
        .deposit(NearToken::from_yoctonear(e.bond))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let inserted = e.request("insert-001", &e.stranger, NearToken::from_near(1)).await?;
    assert_eq!(inserted["proposal_id"].as_u64(), Some(owner + 1), "the agent's proposal takes the next id");

    e.vote(owner, "VoteApprove").await?;
    assert_eq!(e.proposal(owner).await?["status"], "Approved");
    assert_eq!(e.proposal(owner + 1).await?["status"], "InProgress", "the owner's vote must not reach the agent's proposal");
    Ok(())
}
