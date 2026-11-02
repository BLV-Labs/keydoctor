// The Guard in a local sandbox, against the Sputnik v2 wasm that testnet DAOs run (tests/res, plan.md D6).
// GĐ15 asked: can a contract member holding the `agent-guard` role create a transfer proposal and approve it
// alone, with the NEAR moving in the same tx? Since GĐ16 it also runs the full contract: Auto, Pending, sync.
// Needs the Guard wasm: `cargo near build non-reproducible-wasm --no-abi` first (`pnpm test:guard` does it).
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const SPUTNIK_WASM: &str = "tests/res/sputnik_dao_v2.wasm";
const GUARD_WASM: &str = "target/near/kd_guard.wasm";

#[tokio::test]
async fn guard_member_self_approves_a_transfer() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| {
        root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact()
    };
    let council = sub("council", 20).await?.into_result()?;
    let receiver = sub("receiver", 1).await?.into_result()?;
    let guard = sub("guard", 10).await?.into_result()?;
    let dao = sub("dao", 30).await?.into_result()?;

    let dao = dao.deploy(&std::fs::read(SPUTNIK_WASM)?).await?.into_result()?;
    dao.call("new")
        .args_json(json!({ "config": { "name": "spike", "purpose": "GD15", "metadata": "" }, "policy": [council.id()] }))
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
                "max_per_tx": NearToken::from_near(1).as_yoctonear().to_string(),
                "max_per_day": NearToken::from_near(2).as_yoctonear().to_string(),
                "max_pending_per_agent": 3,
                "min_reserve": NearToken::from_near(1).as_yoctonear().to_string(),
            },
            "agents": [{ "account_id": council.id(), "label": "spike agent" }],
            "whitelist": [{ "account_id": receiver.id(), "label": "spike receiver", "max_per_tx": null }],
            "guardians": [],
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let config: Value = guard.view("get_config").await?.json()?;
    assert_eq!(config["proposal_bond"], bond.to_string(), "init must cache the DAO bond: {config}");

    // G-Q1: factory DAOs on testnet (code hash ZGdM2...) reject `ChangePolicyAddOrUpdateRole` ("unknown variant"),
    // so the role goes in through `ChangePolicy` with the whole current policy. Same JSON as scripts/guard-setup/spike.sh.
    let mut new_policy = policy.clone();
    new_policy["roles"].as_array_mut().unwrap().push(json!({
        "name": "agent-guard",
        "kind": { "Group": [guard.id()] },
        "permissions": ["transfer:AddProposal", "transfer:VoteApprove"],
        "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" } }
    }));
    let role_kind = json!({ "ChangePolicy": { "policy": new_policy } });
    let role_id: u64 = council
        .call(dao.id(), "add_proposal")
        .args_json(json!({ "proposal": { "description": "add guard role", "kind": role_kind } }))
        .deposit(NearToken::from_yoctonear(bond))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    council
        .call(dao.id(), "act_proposal")
        .args_json(json!({ "id": role_id, "action": "VoteApprove", "proposal": role_kind }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let proposal: Value = dao.view("get_proposal").args_json(json!({ "id": role_id })).await?.json()?;
    assert_eq!(proposal["status"], "Approved", "the council must accept the role proposal: {proposal}");

    // Auto: whitelisted receiver, within every limit. The Guard proposes and approves in one transaction.
    let amount = NearToken::from_millinear(100);
    let before = receiver.view_account().await?.balance;
    let outcome = council
        .call(guard.id(), "request_transfer")
        .args_json(json!({ "request_id": "spike-auto-1", "receiver_id": receiver.id(), "amount": amount.as_yoctonear().to_string(), "memo": "spike" }))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact()
        .await?;
    // G-Q2: printed so the spike doc can record the real cost (`cargo test -- --nocapture`).
    println!("request_transfer total_gas_burnt={} Tgas", outcome.total_gas_burnt.as_tgas());
    for log in outcome.logs() {
        println!("log: {log}");
    }
    let record: Value = outcome.into_result()?.json()?;
    assert_eq!(record["status"], "AutoApproved", "{record}");
    let id = record["proposal_id"].as_u64().unwrap();

    let proposal: Value = dao.view("get_proposal").args_json(json!({ "id": id })).await?.json()?;
    assert_eq!(proposal["status"], "Approved", "the Guard's own vote must pass the transfer: {proposal}");
    assert_eq!(proposal["proposer"], guard.id().as_str());
    assert!(proposal["description"].as_str().unwrap().starts_with("[KD-GUARD] request=spike-auto-1 "));
    let after = receiver.view_account().await?.balance;
    assert_eq!(after.as_yoctonear() - before.as_yoctonear(), amount.as_yoctonear(), "the NEAR must arrive in the same tx");

    let synced: Value = council
        .call(guard.id(), "sync_request")
        .args_json(json!({ "request_id": "spike-auto-1" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(synced["status"], "Executed", "{synced}");

    // Pending: an unlisted receiver. The proposal waits for the council and no NEAR moves until it votes.
    let record: Value = council
        .call(guard.id(), "request_transfer")
        .args_json(json!({ "request_id": "spike-pending-1", "receiver_id": council.id(), "amount": amount.as_yoctonear().to_string() }))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!((record["status"].as_str(), record["reasons"][0].as_str()), (Some("Pending"), Some("NOT_WHITELISTED")));
    let id = record["proposal_id"].as_u64().unwrap();
    let proposal: Value = dao.view("get_proposal").args_json(json!({ "id": id })).await?.json()?;
    assert_eq!(proposal["status"], "InProgress", "the Guard must not vote on a Pending request: {proposal}");
    council
        .call(dao.id(), "act_proposal")
        .args_json(json!({ "id": id, "action": "VoteApprove", "proposal": proposal["kind"] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let synced: Value = council
        .call(guard.id(), "sync_request")
        .args_json(json!({ "request_id": "spike-pending-1" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(synced["status"], "Executed", "{synced}");
    let agents: Value = guard.view("get_agents").await?.json()?;
    assert_eq!(agents[0]["pending"], 0, "every request is closed: {agents}");
    Ok(())
}
