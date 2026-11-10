// Contract-level unit tests (GĐ16): every error code, the decision paths, the daily limit and its refunds, the
// pending counter, and who may change what. Cross-contract calls are mocked: a test reads the receipts the
// Guard creates and then calls the callback itself with the result the DAO would return.
use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BOND: u128 = NEAR / 10;
const T0: u64 = 1_800_000_000_000_000_000;
const PERIOD: u64 = 7 * policy::DAY_NS;

const GUARD: &str = "guard.testnet";
const DAO: &str = "kd-demo.sputnik-v2.testnet";
const AGENT: &str = "payroll-bot.testnet";
const VENDOR: &str = "vendor.testnet";
const STRANGER: &str = "stranger.testnet";
const GUARDIAN: &str = "guardian.testnet";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn env_full(predecessor: &str, now: u64, deposit: u128, balance: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(GUARD))
        .predecessor_account_id(id(predecessor))
        .signer_account_id(id(predecessor))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance))
        .build());
}

fn env_as(predecessor: &str, now: u64) {
    env_full(predecessor, now, 0, 10 * NEAR);
}

fn limits() -> GuardPolicy {
    GuardPolicy {
        max_per_tx: U128(5 * NEAR),
        max_per_day: U128(20 * NEAR),
        max_pending_per_agent: 3,
        min_reserve: U128(NEAR),
    }
}

fn agent_input(account: &str) -> AgentInput {
    AgentInput { account_id: id(account), label: "payroll bot".into(), public_key: None }
}

fn listed(account: &str, cap: Option<u128>) -> WhitelistInput {
    WhitelistInput { account_id: id(account), label: "vendor".into(), max_per_tx: cap.map(U128) }
}

/// A Guard after init and after the DAO answered `get_policy`.
fn setup() -> Guard {
    env_as(DAO, T0);
    let mut g = Guard::new(id(DAO), limits(), vec![agent_input(AGENT)], vec![listed(VENDOR, None)], vec![id(GUARDIAN)]);
    env_as(GUARD, T0);
    g.on_policy_refreshed(Ok(DaoPolicyView { proposal_bond: U128(BOND), proposal_period: U64(PERIOD) }));
    g
}

fn ask(g: &mut Guard, now: u64, rid: &str, to: &str, amount: u128) {
    env_as(AGENT, now);
    let _ = g.request_transfer(rid.into(), id(to), U128(amount), Some("invoice".into()));
}

fn added(g: &mut Guard, now: u64, rid: &str, result: Result<u64, PromiseError>) {
    env_as(GUARD, now);
    let _ = g.on_proposal_added(rid.into(), None, result);
}

fn voted(g: &mut Guard, now: u64, rid: &str, result: Result<(), PromiseError>) {
    env_as(GUARD, now);
    g.record_vote(rid.into(), result.is_ok());
}

fn synced(g: &mut Guard, now: u64, rid: &str, status: &str, submitted: u64) {
    env_as(GUARD, now);
    g.on_synced(rid.into(), Ok(ProposalView { status: status.into(), submission_time: U64(submitted) }));
}

/// A request through the whole Auto chain: proposal created and the Guard's vote landed.
fn auto_approved(g: &mut Guard, now: u64, rid: &str, amount: u128, proposal_id: u64) {
    ask(g, now, rid, VENDOR, amount);
    added(g, now, rid, Ok(proposal_id));
    voted(g, now, rid, Ok(()));
}

fn rec(g: &Guard, rid: &str) -> RequestRecord {
    g.get_request(rid.into()).unwrap()
}

fn spent(g: &Guard) -> u128 {
    g.get_window()["spent_in_window"].as_str().unwrap().parse().unwrap()
}

fn pending(g: &Guard) -> u64 {
    g.get_agents()[0]["pending"].as_u64().unwrap()
}

/// (receiver, method, deposit, args) of every function call created in the current context.
fn calls() -> Vec<(String, String, u128, Value)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => Some((
                    to.clone(),
                    String::from_utf8(method_name).unwrap(),
                    attached_deposit.as_yoctonear(),
                    near_sdk::serde_json::from_slice(&args).unwrap_or(Value::Null),
                )),
                _ => None,
            })
        })
        .collect()
}

fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn method_called(name: &str) -> bool {
    calls().iter().any(|c| c.1 == name)
}

// ---- init

#[test]
fn init_reads_the_dao_bond_and_period() {
    // Without the bond add_proposal fails, so init must ask the DAO for it straight away.
    env_as(DAO, T0);
    let g = Guard::new(id(DAO), limits(), vec![], vec![], vec![]);
    assert!(calls().iter().any(|c| c.0 == DAO && c.1 == "get_policy"));
    assert!(calls().iter().any(|c| c.0 == GUARD && c.1 == "on_policy_refreshed"));
    assert_eq!(g.get_config()["proposal_bond"], "0");

    let g = setup();
    assert_eq!(g.get_config()["proposal_bond"], BOND.to_string());
    assert_eq!(g.get_config()["proposal_period"], PERIOD.to_string());
}

#[test]
#[should_panic(expected = "TOO_MANY_AGENTS")]
fn init_caps_agents_at_10() {
    env_as(DAO, T0);
    let agents = (0..11).map(|i| agent_input(&format!("agent{i}.testnet"))).collect();
    Guard::new(id(DAO), limits(), agents, vec![], vec![]);
}

#[test]
#[should_panic(expected = "TOO_MANY_WHITELIST")]
fn init_caps_whitelist_at_50() {
    env_as(DAO, T0);
    let wl = (0..51).map(|i| listed(&format!("vendor{i}.testnet"), None)).collect();
    Guard::new(id(DAO), limits(), vec![], wl, vec![]);
}

#[test]
#[should_panic(expected = "TOO_MANY_GUARDIANS")]
fn init_caps_guardians_at_5() {
    env_as(DAO, T0);
    let guardians = (0..6).map(|i| id(&format!("guardian{i}.testnet"))).collect();
    Guard::new(id(DAO), limits(), vec![], vec![], guardians);
}

#[test]
#[should_panic(expected = "LABEL_TOO_LONG")]
fn init_rejects_long_labels() {
    env_as(DAO, T0);
    let agent = AgentInput { account_id: id(AGENT), label: "x".repeat(65), public_key: None };
    Guard::new(id(DAO), limits(), vec![agent], vec![], vec![]);
}

// ---- request_transfer: the 8 hard errors (§11.5.4 checks 1–7 plus the balance check)

#[test]
#[should_panic(expected = "PAUSED")]
fn paused_guard_rejects_requests() {
    let mut g = setup();
    env_as(GUARDIAN, T0);
    g.pause();
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
}

#[test]
#[should_panic(expected = "PAUSED")]
fn paused_is_checked_before_the_caller() {
    // The emergency brake answers everyone the same way, even accounts that are not agents.
    let mut g = setup();
    env_as(GUARDIAN, T0);
    g.pause();
    env_as(STRANGER, T0);
    let _ = g.request_transfer("req-0001".into(), id(VENDOR), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "UNKNOWN_AGENT")]
fn only_registered_agents_may_request() {
    let mut g = setup();
    env_as(STRANGER, T0);
    let _ = g.request_transfer("req-0001".into(), id(VENDOR), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "AGENT_DISABLED")]
fn disabled_agent_is_rejected() {
    let mut g = setup();
    env_as(DAO, T0);
    g.set_agent_enabled(id(AGENT), false);
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
}

#[test]
#[should_panic(expected = "INVALID_REQUEST_ID")]
fn short_request_id_is_rejected() {
    let mut g = setup();
    ask(&mut g, T0, "req-1", VENDOR, NEAR);
}

#[test]
#[should_panic(expected = "DUPLICATE_REQUEST")]
fn request_id_is_single_use() {
    // An agent retrying after a timeout must not pay twice.
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
}

#[test]
#[should_panic(expected = "INVALID_AMOUNT")]
fn zero_amount_is_rejected() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, 0);
}

#[test]
#[should_panic(expected = "TOO_MANY_PENDING")]
fn pending_cap_stops_a_proposal_flood() {
    // Each proposal costs a bond; a looping agent stops at max_pending_per_agent open requests.
    let mut g = setup();
    for i in 0..3 {
        ask(&mut g, T0, &format!("req-000{i}"), STRANGER, NEAR);
    }
    ask(&mut g, T0, "req-0009", STRANGER, NEAR);
}

#[test]
#[should_panic(expected = "INSUFFICIENT_GUARD_BALANCE")]
fn guard_keeps_bond_plus_reserve() {
    let mut g = setup();
    env_full(AGENT, T0, 0, BOND + NEAR - 1);
    let _ = g.request_transfer("req-0001".into(), id(VENDOR), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "INSUFFICIENT_GUARD_BALANCE")]
fn guard_keeps_bond_plus_storage_when_storage_outgrows_the_reserve() {
    // Request records are stored at the Guard's cost: once they outgrow min_reserve, the storage cost is the floor.
    let mut g = setup();
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(GUARD))
        .predecessor_account_id(id(AGENT))
        .account_balance(NearToken::from_yoctonear(BOND + 3 * NEAR - 1))
        .storage_usage(300_000) // 3 NEAR of storage > 1 NEAR reserve
        .build());
    let _ = g.request_transfer("req-0001".into(), id(VENDOR), U128(NEAR), None);
}

// ---- decision paths

#[test]
fn auto_request_creates_a_proposal_with_the_bond_and_counts_the_amount() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, 2 * NEAR);

    let add = calls().into_iter().find(|c| c.1 == "add_proposal").unwrap();
    assert_eq!((add.0.as_str(), add.2), (DAO, BOND));
    let description = add.3["proposal"]["description"].as_str().unwrap();
    assert!(description.starts_with("[KD-GUARD] request=req-0001 agent=payroll-bot.testnet decision=auto reasons=-"));
    assert_eq!(add.3["proposal"]["kind"]["Transfer"]["amount"], (2 * NEAR).to_string());
    assert!(method_called("on_proposal_added"));

    let r = rec(&g, "req-0001");
    assert_eq!((r.status, r.decision, r.counted_in_window), (RequestStatus::Submitted, Decision::Auto, true));
    assert_eq!(spent(&g), 2 * NEAR, "Auto reserves the daily limit before the vote");
    assert_eq!(pending(&g), 1);
    let log = &get_logs()[0];
    assert!(log.starts_with("EVENT_JSON:") && log.contains(r#""standard":"kd_guard""#));
    assert!(log.contains(r#""event":"request_submitted""#));
}

#[test]
fn auto_chain_votes_approve_and_frees_the_pending_slot() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, 2 * NEAR);
    added(&mut g, T0, "req-0001", Ok(7));
    let act = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!(act.0, DAO);
    assert_eq!((act.3["id"].as_u64(), act.3["action"].as_str()), (Some(7), Some("VoteApprove")));
    assert_eq!(act.3["proposal"]["Transfer"]["receiver_id"], VENDOR, "Sputnik checks the kind it votes on");

    voted(&mut g, T0, "req-0001", Ok(()));
    let r = rec(&g, "req-0001");
    assert_eq!((r.status, r.proposal_id), (RequestStatus::AutoApproved, Some(7)));
    assert_eq!(pending(&g), 0);
    assert_eq!(spent(&g), 2 * NEAR);
    assert_eq!(g.get_request_by_proposal(7).unwrap().request_id, "req-0001");
}

#[test]
fn pending_request_never_votes_and_never_counts() {
    // An unlisted receiver waits for the council; the Guard must not vote or use the daily limit.
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, NEAR);
    let r = rec(&g, "req-0001");
    assert_eq!((r.decision, r.reasons.clone()), (Decision::Pending, vec!["NOT_WHITELISTED".to_string()]));
    assert_eq!(spent(&g), 0);

    added(&mut g, T0, "req-0001", Ok(3));
    assert!(!method_called("act_proposal"));
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Pending);
    assert_eq!(pending(&g), 1, "still waiting on the council");
}

#[test]
fn recipient_cap_overrides_the_global_cap() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_whitelist(id("small-vendor.testnet"), "small".into(), Some(U128(NEAR)));
    ask(&mut g, T0, "req-0001", "small-vendor.testnet", NEAR + 1);
    assert_eq!(rec(&g, "req-0001").reasons, ["OVER_RECIPIENT_LIMIT"]);
}

#[test]
fn removed_receiver_is_no_longer_auto() {
    let mut g = setup();
    env_as(DAO, T0);
    g.remove_whitelist(id(VENDOR));
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
    assert_eq!(rec(&g, "req-0001").reasons, ["NOT_WHITELISTED"]);
}

// ---- daily limit

#[test]
fn daily_limit_turns_the_fifth_request_pending() {
    // 4 × 5 NEAR fill the 20 NEAR window; the next request goes to the council even though it is within max_per_tx.
    let mut g = setup();
    for i in 0..4u64 {
        auto_approved(&mut g, T0 + i, &format!("req-000{i}"), 5 * NEAR, i);
    }
    assert_eq!(spent(&g), 20 * NEAR);
    ask(&mut g, T0 + 10, "req-0009", VENDOR, 1);
    assert_eq!(rec(&g, "req-0009").reasons, ["OVER_DAILY_LIMIT"]);
    assert_eq!(g.get_window()["remaining"], "0");
}

#[test]
fn window_resets_after_24_hours() {
    let mut g = setup();
    auto_approved(&mut g, T0, "req-0001", 5 * NEAR, 1);
    env_as(STRANGER, T0 + policy::DAY_NS);
    assert_eq!(spent(&g), 0, "the view shows the window the next request will see");
    ask(&mut g, T0 + policy::DAY_NS, "req-0002", VENDOR, 5 * NEAR);
    assert_eq!(rec(&g, "req-0002").decision, Decision::Auto);
    assert_eq!(spent(&g), 5 * NEAR);
}

#[test]
fn add_proposal_failure_refunds_the_limit() {
    // No proposal means no money moved: the reserved amount must come back.
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, 5 * NEAR);
    added(&mut g, T0, "req-0001", Err(PromiseError::Failed));
    let r = rec(&g, "req-0001");
    assert_eq!((r.status, r.counted_in_window), (RequestStatus::Failed, false));
    assert_eq!(spent(&g), 0);
    assert_eq!(pending(&g), 0);
}

#[test]
fn vote_failure_refunds_the_limit() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, 5 * NEAR);
    added(&mut g, T0, "req-0001", Ok(1));
    voted(&mut g, T0, "req-0001", Err(PromiseError::Failed));
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Failed);
    assert_eq!(spent(&g), 0);
    assert_eq!(pending(&g), 0);
    assert!(get_logs().iter().any(|l| l.contains("stays InProgress")));
}

#[test]
fn failed_execution_refunds_in_the_same_window() {
    let mut g = setup();
    auto_approved(&mut g, T0, "req-0001", 5 * NEAR, 1);
    synced(&mut g, T0 + 60, "req-0001", "Failed", T0);
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Failed);
    assert_eq!(spent(&g), 0);
}

#[test]
fn no_refund_into_a_later_window() {
    // A refund after the reset would let today's window spend more than max_per_day.
    let mut g = setup();
    auto_approved(&mut g, T0, "req-0001", 5 * NEAR, 1);
    let next_day = T0 + policy::DAY_NS + 1;
    auto_approved(&mut g, next_day, "req-0002", 3 * NEAR, 2);
    synced(&mut g, next_day, "req-0001", "Failed", T0);
    let r = rec(&g, "req-0001");
    assert_eq!((r.status, r.counted_in_window), (RequestStatus::Failed, true));
    assert_eq!(spent(&g), 3 * NEAR);
}

#[test]
fn executed_keeps_the_amount_counted() {
    let mut g = setup();
    auto_approved(&mut g, T0, "req-0001", 5 * NEAR, 1);
    synced(&mut g, T0 + 60, "req-0001", "Approved", T0);
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Executed);
    assert_eq!(spent(&g), 5 * NEAR);
}

// ---- sync_request

#[test]
fn sync_asks_the_dao_for_an_open_request() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, NEAR);
    added(&mut g, T0, "req-0001", Ok(4));
    env_as(STRANGER, T0 + 60);
    assert!(matches!(g.sync_request("req-0001".into()), PromiseOrValue::Promise(_)));
    let get = calls().into_iter().find(|c| c.1 == "get_proposal").unwrap();
    assert_eq!((get.0.as_str(), get.3["id"].as_u64()), (DAO, Some(4)));
}

#[test]
fn sync_of_a_final_request_reads_nothing() {
    let mut g = setup();
    auto_approved(&mut g, T0, "req-0001", NEAR, 1);
    synced(&mut g, T0, "req-0001", "Approved", T0);
    env_as(STRANGER, T0 + 60);
    match g.sync_request("req-0001".into()) {
        PromiseOrValue::Value(r) => assert_eq!(r.status, RequestStatus::Executed),
        PromiseOrValue::Promise(_) => panic!("a final request must not call the DAO"),
    }
}

#[test]
#[should_panic(expected = "UNKNOWN_REQUEST")]
fn sync_of_an_unknown_request_fails() {
    let mut g = setup();
    let _ = g.sync_request("req-0404".into());
}

#[test]
fn council_approval_executes_without_touching_the_window() {
    // Money the council approves is outside the Guard's own daily budget (§11.5.7).
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, 50 * NEAR);
    added(&mut g, T0, "req-0001", Ok(2));
    synced(&mut g, T0 + 60, "req-0001", "Approved", T0);
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Executed);
    assert_eq!(pending(&g), 0);
    assert_eq!(spent(&g), 0);
}

#[test]
fn council_rejection_frees_the_slot() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, NEAR);
    added(&mut g, T0, "req-0001", Ok(2));
    synced(&mut g, T0 + 60, "req-0001", "Rejected", T0);
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Rejected);
    assert_eq!(pending(&g), 0);
}

#[test]
fn ignored_proposal_expires_after_the_dao_period() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, NEAR);
    added(&mut g, T0, "req-0001", Ok(2));
    synced(&mut g, T0 + PERIOD - 1, "req-0001", "InProgress", T0);
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Pending);
    synced(&mut g, T0 + PERIOD, "req-0001", "InProgress", T0);
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Expired);
    assert_eq!(pending(&g), 0);
}

#[test]
fn unreadable_pending_proposal_counts_as_removed() {
    // Sputnik deletes a Removed proposal, so get_proposal fails; the slot must not stay taken forever.
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, NEAR);
    added(&mut g, T0, "req-0001", Ok(2));
    env_as(GUARD, T0 + 60);
    g.on_synced("req-0001".into(), Err(PromiseError::Failed));
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Rejected);
    assert_eq!(pending(&g), 0);
}

#[test]
fn unreadable_auto_proposal_changes_nothing() {
    // For an Auto request a failed read must not refund: the NEAR may already have left.
    let mut g = setup();
    auto_approved(&mut g, T0, "req-0001", 5 * NEAR, 1);
    env_as(GUARD, T0 + 60);
    g.on_synced("req-0001".into(), Err(PromiseError::Failed));
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::AutoApproved);
    assert_eq!(spent(&g), 5 * NEAR);
}

#[test]
fn late_vote_callback_keeps_the_synced_final_status() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
    added(&mut g, T0, "req-0001", Ok(1));
    synced(&mut g, T0, "req-0001", "Approved", T0);
    voted(&mut g, T0, "req-0001", Ok(()));
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Executed);
    assert_eq!(pending(&g), 0, "the slot is freed once, not twice");
}

#[test]
fn removed_agent_does_not_break_a_late_callback() {
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, NEAR);
    env_as(DAO, T0);
    g.remove_agent(id(AGENT));
    added(&mut g, T0, "req-0001", Err(PromiseError::Failed));
    assert_eq!(rec(&g, "req-0001").status, RequestStatus::Failed);
}

// ---- configuration and pause

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn stranger_cannot_set_policy() {
    let mut g = setup();
    env_as(STRANGER, T0);
    g.set_policy(limits());
}

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn agent_cannot_whitelist_itself_a_receiver() {
    // The agent is the party the Guard limits; it must never widen its own limits.
    let mut g = setup();
    env_full(AGENT, T0, NEAR, 10 * NEAR);
    g.add_whitelist(id(STRANGER), "mine".into(), None);
}

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn stranger_cannot_add_an_agent() {
    let mut g = setup();
    env_full(STRANGER, T0, NEAR, 10 * NEAR);
    g.add_agent(id(STRANGER), "me".into(), None);
}

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn guardian_cannot_unpause() {
    let mut g = setup();
    env_as(GUARDIAN, T0);
    g.pause();
    g.unpause();
}

#[test]
#[should_panic(expected = "NOT_GUARDIAN")]
fn stranger_cannot_pause() {
    let mut g = setup();
    env_as(STRANGER, T0);
    g.pause();
}

#[test]
fn guardian_pauses_and_dao_unpauses() {
    let mut g = setup();
    env_as(GUARDIAN, T0);
    g.pause();
    assert_eq!(g.get_config()["paused"], true);
    assert!(get_logs()[0].contains(r#""event":"paused""#));
    env_as(DAO, T0);
    g.unpause();
    assert_eq!(g.get_config()["paused"], false);
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
}

#[test]
fn dao_policy_change_applies_to_the_next_request() {
    let mut g = setup();
    env_as(DAO, T0);
    g.set_policy(GuardPolicy { max_per_tx: U128(NEAR), ..limits() });
    ask(&mut g, T0, "req-0001", VENDOR, 2 * NEAR);
    assert_eq!(rec(&g, "req-0001").reasons, ["OVER_PER_TX"]);
}

#[test]
#[should_panic(expected = "INSUFFICIENT_STORAGE_DEPOSIT")]
fn adding_data_needs_a_storage_deposit() {
    let mut g = setup();
    env_as(DAO, T0);
    g.add_whitelist(id("new-vendor.testnet"), "new".into(), None);
}

#[test]
fn storage_deposit_excess_goes_back_to_the_dao() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_whitelist(id("new-vendor.testnet"), "new".into(), None);
    let refund = transfers();
    assert_eq!(refund.len(), 1);
    assert_eq!(refund[0].0, DAO);
    assert!(refund[0].1 > 0 && refund[0].1 < NEAR, "only the storage cost is kept");
    assert_eq!(g.get_whitelist().len(), 2);
}

#[test]
#[should_panic(expected = "TOO_MANY_WHITELIST")]
fn whitelist_add_respects_the_cap() {
    env_as(DAO, T0);
    let wl = (0..50).map(|i| listed(&format!("vendor{i}.testnet"), None)).collect();
    let mut g = Guard::new(id(DAO), limits(), vec![], wl, vec![]);
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_whitelist(id("vendor50.testnet"), "one more".into(), None);
}

#[test]
#[should_panic(expected = "TOO_MANY_AGENTS")]
fn agent_add_respects_the_cap() {
    env_as(DAO, T0);
    let agents = (0..10).map(|i| agent_input(&format!("agent{i}.testnet"))).collect();
    let mut g = Guard::new(id(DAO), limits(), agents, vec![], vec![]);
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id("agent10.testnet"), "one more".into(), None);
}

#[test]
#[should_panic(expected = "TOO_MANY_GUARDIANS")]
fn guardian_add_respects_the_cap() {
    env_as(DAO, T0);
    let guardians = (0..5).map(|i| id(&format!("guardian{i}.testnet"))).collect();
    let mut g = Guard::new(id(DAO), limits(), vec![], vec![], guardians);
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_guardian(id("guardian5.testnet"));
}

#[test]
#[should_panic(expected = "GET_POLICY_FAILED")]
fn failed_policy_read_is_loud() {
    let mut g = setup();
    env_as(GUARD, T0);
    g.on_policy_refreshed(Err(PromiseError::Failed));
}

#[test]
fn refresh_bond_rereads_the_dao_policy() {
    let mut g = setup();
    env_as(DAO, T0);
    let _ = g.refresh_bond();
    assert!(calls().iter().any(|c| c.0 == DAO && c.1 == "get_policy"));
}

#[test]
fn withdraw_excess_keeps_the_reserve() {
    // Keeps min_reserve, or the storage cost when that is higher, so the Guard can still pay bonds and storage.
    let mut g = setup();
    let at_storage = |bytes: u64| {
        testing_env!(VMContextBuilder::new()
            .current_account_id(id(GUARD))
            .predecessor_account_id(id(DAO))
            .account_balance(NearToken::from_near(10))
            .storage_usage(bytes)
            .build());
    };
    at_storage(10_000); // 0.1 NEAR of storage < 1 NEAR reserve
    let _ = g.withdraw_excess();
    assert_eq!(transfers(), [(DAO.to_string(), 9 * NEAR)]);
    at_storage(300_000); // 3 NEAR of storage > reserve
    let _ = g.withdraw_excess();
    assert_eq!(transfers(), [(DAO.to_string(), 7 * NEAR)]);
}

#[test]
#[should_panic(expected = "NOTHING_TO_WITHDRAW")]
fn withdraw_with_nothing_above_the_reserve_fails() {
    let mut g = setup();
    env_full(DAO, T0, 0, NEAR);
    let _ = g.withdraw_excess();
}

// ---- views

#[test]
fn list_requests_is_newest_first_over_the_last_200() {
    let mut g = setup();
    env_as(DAO, T0);
    g.set_policy(GuardPolicy { max_pending_per_agent: 1_000, ..limits() });
    for i in 0..205 {
        ask(&mut g, T0 + i, &format!("req-{i:05}"), STRANGER, NEAR);
    }
    let page = g.list_requests(None, None);
    assert_eq!(page.len(), 20);
    assert_eq!(page[0].request_id, "req-00204");
    assert_eq!(page[19].request_id, "req-00185");
    let tail = g.list_requests(Some(195), Some(50));
    assert_eq!(tail.iter().map(|r| r.request_id.as_str()).collect::<Vec<_>>(), [
        "req-00009", "req-00008", "req-00007", "req-00006", "req-00005"
    ]);
    assert_eq!(g.list_requests(None, Some(500)).len(), 50);
    assert!(g.get_request("req-00000".into()).is_some(), "the ring only bounds the list, not the records");
}

#[test]
fn kd_guard_info_identifies_the_guard() {
    let g = setup();
    assert_eq!(g.kd_guard_info()["standard"], "kd_guard");
    assert_eq!(g.kd_guard_info()["dao_id"], DAO);
}

// ---- agent accounts (§11.10.2): the Guard makes the account, so the key's scope is not the caller's to choose

const AGENT_SUB: &str = "a1.guard.testnet";
const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

fn key() -> PublicKey {
    KEY.parse().unwrap()
}

fn keyed_input(account: &str) -> AgentInput {
    AgentInput { public_key: Some(key()), ..agent_input(account) }
}

/// The actions of the one receipt that goes to `account`.
fn actions_to(account: &str) -> Vec<MockAction> {
    let receipts = get_created_receipts();
    let found: Vec<_> = receipts.iter().filter(|r| r.receiver_id.as_str() == account).collect();
    assert_eq!(found.len(), 1, "one receipt to {account}: {receipts:?}");
    found[0].actions.clone()
}

/// What makes the key safe to hand to an agent: it reaches only the Guard, only the two agent methods, and the
/// account starts with the gas fund and nothing else.
fn assert_agent_account(actions: &[MockAction]) {
    assert!(matches!(actions[0], MockAction::CreateAccount { .. }), "{actions:?}");
    assert!(
        matches!(&actions[1], MockAction::Transfer { deposit, .. } if *deposit == AGENT_GAS_FUND),
        "{actions:?}"
    );
    match &actions[2] {
        MockAction::AddKeyWithFunctionCall { public_key, allowance, receiver_id, method_names, .. } => {
            assert_eq!(public_key.to_string(), KEY);
            assert_eq!(*allowance, None, "the account balance is the cap, not a key allowance");
            assert_eq!(receiver_id.as_str(), GUARD, "the key must not reach any other contract");
            assert_eq!(method_names.join(","), "request_transfer,sync_request");
        }
        other => panic!("expected a function-call key, got {other:?}"),
    }
    assert_eq!(actions.len(), 3, "no full-access key and nothing else: {actions:?}");
}

#[test]
fn add_agent_with_a_key_creates_a_narrow_account() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "payroll bot".into(), Some(key()));
    assert_agent_account(&actions_to(AGENT_SUB));
}

fn keyed_agent_enabled(g: &Guard) -> Option<bool> {
    g.get_agents().iter().find(|a| a["account_id"] == AGENT_SUB).map(|a| a["enabled"].as_bool().unwrap())
}

#[test]
#[should_panic(expected = "AGENT_DISABLED")]
fn a_reused_name_gets_no_window_before_the_new_account_is_confirmed() {
    // The caller here may be the old account with the key of a removed agent: the DAO took that key out, so it must
    // not spend again in the blocks before account creation fails.
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    env_as(AGENT_SUB, T0);
    let _ = g.request_transfer("req-0001".into(), id(VENDOR), U128(NEAR), None);
}

#[test]
fn a_keyed_agent_works_only_after_its_account_is_created() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    assert_eq!(keyed_agent_enabled(&g), Some(false));
    g.on_agent_created(id(AGENT_SUB), Ok(()));
    assert_eq!(keyed_agent_enabled(&g), Some(true));
}

#[test]
#[should_panic(expected = "AGENT_CREATING")]
fn an_agent_cannot_be_removed_while_its_account_is_being_created() {
    // Otherwise remove + re-add with a new key lets the first callback confirm the second entry, and the account
    // holds the removed key: the key the DAO meant to drop would pass as the new agent.
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    g.remove_agent(id(AGENT_SUB));
}

#[test]
fn an_agent_can_be_removed_once_its_account_exists() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    g.on_agent_created(id(AGENT_SUB), Ok(()));
    g.remove_agent(id(AGENT_SUB));
    assert_eq!(keyed_agent_enabled(&g), None);
}

#[test]
fn a_late_callback_does_not_undo_a_disable_by_the_dao() {
    // The DAO disabled this agent on purpose; account creation finishing must not switch it back on.
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    env_full(DAO, T0, 0, 10 * NEAR);
    g.set_agent_enabled(id(AGENT_SUB), false);
    g.on_agent_created(id(AGENT_SUB), Ok(()));
    assert_eq!(keyed_agent_enabled(&g), Some(false));
}

#[test]
fn enabling_during_creation_does_not_open_the_window() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    env_full(DAO, T0, 0, 10 * NEAR);
    g.set_agent_enabled(id(AGENT_SUB), true);
    assert_eq!(keyed_agent_enabled(&g), Some(false));
}

#[test]
fn a_failed_creation_leaves_an_entry_the_dao_added_again() {
    // An entry not `creating` is not the one this callback was for, so it stays. Only an outside agent can be
    // re-added without a key, so the entry is set up as already created.
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    g.on_agent_created(id(AGENT_SUB), Ok(()));
    g.on_agent_created(id(AGENT_SUB), Err(PromiseError::Failed));
    assert_eq!(keyed_agent_enabled(&g), Some(true));
}

#[test]
#[should_panic(expected = "AGENT_KEY_REQUIRED")]
fn a_removed_agent_account_cannot_return_with_its_old_key() {
    // Removing `a1.<guard>` is how the DAO answers a leaked key; that account and key stay on chain.
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
    g.on_agent_created(id(AGENT_SUB), Ok(()));
    g.remove_agent(id(AGENT_SUB));
    g.add_agent(id(AGENT_SUB), "x".into(), None);
}

#[test]
fn new_with_a_key_creates_the_same_narrow_account() {
    env_as(DAO, T0);
    Guard::new(id(DAO), limits(), vec![keyed_input(AGENT_SUB)], vec![], vec![]);
    assert_agent_account(&actions_to(AGENT_SUB));
}

#[test]
#[should_panic(expected = "AGENT_NOT_SUBACCOUNT")]
fn add_agent_with_a_key_needs_a_guard_subaccount() {
    // A name outside the Guard could not be created by it; the agent must not get registered with no account.
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id("elsewhere.testnet"), "x".into(), Some(key()));
}

#[test]
#[should_panic(expected = "INSUFFICIENT_STORAGE_DEPOSIT")]
fn add_agent_with_a_key_makes_the_dao_pay_the_gas_fund() {
    // The fund must come from the proposal, not from the balance the limits protect.
    let mut g = setup();
    env_full(DAO, T0, AGENT_GAS_FUND.as_yoctonear() - 1, 10 * NEAR);
    g.add_agent(id(AGENT_SUB), "x".into(), Some(key()));
}

#[test]
#[should_panic(expected = "AGENT_EXISTS")]
fn a_key_cannot_be_added_to_a_registered_agent() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id(AGENT), "x".into(), Some(key()));
}

#[test]
fn add_agent_without_a_key_only_registers() {
    let mut g = setup();
    env_full(DAO, T0, NEAR, 10 * NEAR);
    g.add_agent(id("second.testnet"), "x".into(), None);
    let receipts = get_created_receipts();
    assert!(
        receipts.iter().all(|r| r.actions.iter().all(|a| matches!(a, MockAction::Transfer { .. }))),
        "only the deposit refund: {receipts:?}"
    );
}

// ---- upgrade (§11.5.12): the Guard has no key, so whoever reaches `upgrade` owns the code and the DAO's budget

fn code_hash(code: &[u8]) -> Base58CryptoHash {
    env::sha256_array(code).into()
}

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn only_the_dao_upgrades_the_guard() {
    let g = setup();
    env_as(AGENT, T0);
    g.upgrade(id(STRANGER), code_hash(b"code")).detach();
}

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn a_guardian_cannot_upgrade_the_guard() {
    let g = setup();
    env_as(GUARDIAN, T0);
    g.upgrade(id(STRANGER), code_hash(b"code")).detach();
}

#[test]
fn the_dao_upgrade_asks_the_named_source_for_the_code() {
    let g = setup();
    env_as(DAO, T0);
    g.upgrade(id("factory.testnet"), code_hash(b"code")).detach();
    let actions = actions_to("factory.testnet");
    assert!(
        matches!(&actions[0], MockAction::FunctionCallWeight { method_name, .. } if method_name == b"get_guard_code"),
        "{actions:?}"
    );
}

/// `on_code` as the runtime calls it: from the Guard itself, with the source's reply as promise result 0.
fn on_code_gets(g: &Guard, reply: PromiseResult, hash: Base58CryptoHash) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id(GUARD))
            .predecessor_account_id(id(GUARD))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![reply]
    );
    g.on_code(hash).detach();
}

#[test]
#[should_panic(expected = "CODE_HASH_MISMATCH")]
fn code_other_than_what_the_dao_approved_is_not_deployed() {
    // The source is untrusted by design: it may be the factory, or anything else the proposal named.
    let g = setup();
    on_code_gets(&g, PromiseResult::Successful(b"evil".to_vec()), code_hash(b"approved"));
}

#[test]
#[should_panic(expected = "CODE_UNAVAILABLE")]
fn a_source_that_fails_deploys_nothing() {
    let g = setup();
    on_code_gets(&g, PromiseResult::Failed, code_hash(b"approved"));
}

#[test]
fn the_approved_code_is_deployed_and_migrated_in_one_receipt() {
    let g = setup();
    on_code_gets(&g, PromiseResult::Successful(b"approved".to_vec()), code_hash(b"approved"));
    let actions = actions_to(GUARD);
    assert!(matches!(&actions[0], MockAction::DeployContract { code, .. } if code == b"approved"), "{actions:?}");
    assert!(
        matches!(&actions[1], MockAction::FunctionCallWeight { method_name, .. } if method_name == b"migrate"),
        "{actions:?}"
    );
}

// ---- spend per agent (§4.11 `BudgetInfo.agents[].spent_24h`): the owner must see which agent spent the daily limit.

const AGENT_2: &str = "refund-bot.testnet";

fn setup_two_agents() -> Guard {
    env_as(DAO, T0);
    let agents = vec![agent_input(AGENT), agent_input(AGENT_2)];
    let mut g = Guard::new(id(DAO), limits(), agents, vec![listed(VENDOR, None)], vec![]);
    env_as(GUARD, T0);
    g.on_policy_refreshed(Ok(DaoPolicyView { proposal_bond: U128(BOND), proposal_period: U64(PERIOD) }));
    g
}

fn agent_spent(g: &Guard, account: &str) -> u128 {
    let agents = g.get_agents();
    let a = agents.iter().find(|a| a["account_id"] == account).unwrap();
    a["spent_24h"].as_str().unwrap().parse().unwrap()
}

#[test]
fn each_agent_sees_only_its_own_auto_spend() {
    // The daily limit is shared, so without this the owner cannot tell which agent used it up.
    let mut g = setup_two_agents();
    auto_approved(&mut g, T0 + 1, "req-0001", 3 * NEAR, 1);
    auto_approved(&mut g, T0 + 2, "req-0002", NEAR, 2);
    env_as(AGENT_2, T0 + 3);
    let _ = g.request_transfer("req-0003".into(), id(VENDOR), U128(2 * NEAR), None);
    assert_eq!((agent_spent(&g, AGENT), agent_spent(&g, AGENT_2)), (4 * NEAR, 2 * NEAR));
    assert_eq!(spent(&g), 6 * NEAR, "the agents' parts add up to the Guard's total");
}

#[test]
fn a_request_the_council_decides_is_not_agent_spend() {
    // It does not count toward the Guard's total either: the agent's part must not exceed the whole.
    let mut g = setup();
    ask(&mut g, T0 + 1, "req-0001", STRANGER, NEAR);
    added(&mut g, T0 + 1, "req-0001", Ok(1));
    synced(&mut g, T0 + 2, "req-0001", "Approved", T0 + 1);
    assert_eq!(agent_spent(&g, AGENT), 0);
}

#[test]
fn a_payment_that_failed_leaves_the_agents_spend() {
    // The refund that gives the limit back must also clear the agent, or the two totals drift apart.
    let mut g = setup();
    ask(&mut g, T0 + 1, "req-0001", VENDOR, NEAR);
    added(&mut g, T0 + 1, "req-0001", Err(PromiseError::Failed));
    assert_eq!(agent_spent(&g, AGENT), 0, "add_proposal failed");

    auto_approved(&mut g, T0 + 2, "req-0002", 2 * NEAR, 2);
    auto_approved(&mut g, T0 + 3, "req-0003", 3 * NEAR, 3);
    synced(&mut g, T0 + 4, "req-0002", "Failed", T0 + 2);
    assert_eq!(agent_spent(&g, AGENT), 3 * NEAR, "the transfer failed");
    assert_eq!(spent(&g), 3 * NEAR);
}

#[test]
fn agent_spend_resets_with_the_window() {
    // No request runs at the reset, so the view must not show yesterday's spend as today's.
    let mut g = setup();
    auto_approved(&mut g, T0 + 1, "req-0001", 3 * NEAR, 1);
    env_as(STRANGER, T0 + policy::DAY_NS);
    assert_eq!(agent_spent(&g, AGENT), 0, "the view reads a past window as reset");

    auto_approved(&mut g, T0 + policy::DAY_NS, "req-0002", NEAR, 2);
    assert_eq!(agent_spent(&g, AGENT), NEAR, "the first request of a new window does not add to the old amount");
}

#[test]
fn a_late_failure_does_not_touch_the_next_windows_agent_spend() {
    // Same rule as `no_refund_into_a_later_window`: yesterday's payment is not part of today's amount.
    let mut g = setup();
    auto_approved(&mut g, T0 + 1, "req-0001", 3 * NEAR, 1);
    auto_approved(&mut g, T0 + policy::DAY_NS, "req-0002", 2 * NEAR, 2);
    synced(&mut g, T0 + policy::DAY_NS + 1, "req-0001", "Failed", T0 + 1);
    assert_eq!(agent_spent(&g, AGENT), 2 * NEAR);
}

#[test]
fn removing_an_agent_keeps_its_spend_in_the_guards_total() {
    // Removing and re-adding an agent must not reset the limit, and its late failure must still refund the Guard.
    let mut g = setup();
    auto_approved(&mut g, T0 + 1, "req-0001", 3 * NEAR, 1);
    env_as(DAO, T0 + 2);
    g.remove_agent(id(AGENT));
    assert_eq!(spent(&g), 3 * NEAR);
    synced(&mut g, T0 + 3, "req-0001", "Failed", T0 + 1);
    assert_eq!(spent(&g), 0);
}

// ---- plans (§11.11, ADR 0005 K2)

const MINUTE: u64 = 60_000_000_000;

fn plan_of(action: PlanAction, amount: u128, runs: u32) -> PlanInput {
    PlanInput {
        action,
        strategy_id: "dca".into(),
        token_in: "".into(),
        amount_per_run: U128(amount),
        interval_sec: 60,
        runs_total: runs,
        start_at: U64(T0 + MINUTE),
    }
}

fn pay_vendor(runs: u32) -> PlanInput {
    plan_of(PlanAction::Transfer { receiver_id: id(VENDOR) }, NEAR, runs)
}

fn pool_call() -> PlanAction {
    PlanAction::Call {
        target: id("pool.testnet"),
        method: "deposit".into(),
        args_base64: b"{\"to\":1}".to_vec().into(),
        deposit: U128(NEAR / 100),
        gas: U64(30_000_000_000_000),
    }
}

fn create(g: &mut Guard, plan: PlanInput) -> u32 {
    env_full(DAO, T0, NEAR / 10, 10 * NEAR);
    g.create_plan(plan)
}

fn step(g: &mut Guard, now: u64, plan_id: u32) {
    env_as(STRANGER, now);
    let _ = g.execute_plan_step(plan_id);
}

fn step_id(plan_id: u32, due: u64) -> String {
    format!("plan-{plan_id}-{due}")
}

/// The step due at `due` through the whole chain, up to the Guard's vote.
fn paid_step(g: &mut Guard, due: u64, plan_id: u32, proposal_id: u64) {
    step(g, due, plan_id);
    added(g, due, &step_id(plan_id, due), Ok(proposal_id));
    voted(g, due, &step_id(plan_id, due), Ok(()));
}

fn plan(g: &Guard, plan_id: u32) -> Plan {
    g.get_plan(plan_id).unwrap()
}

fn due_at(g: &Guard, plan_id: u32) -> u64 {
    plan(g, plan_id).next_run_at.unwrap().0
}

fn logged(text: &str) -> bool {
    get_logs().iter().any(|l| l.contains(text))
}

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn an_agent_cannot_write_a_plan() {
    // A plan spends without asking anyone at run time, so it needs the owner's vote at creation.
    let mut g = setup();
    env_full(AGENT, T0, NEAR, 10 * NEAR);
    g.create_plan(pay_vendor(3));
}

#[test]
#[should_panic(expected = "INSUFFICIENT_STORAGE_DEPOSIT")]
fn a_plan_pays_for_its_own_storage() {
    // Plans have no count limit; the deposit is what stops them eating the Guard's NEAR.
    let mut g = setup();
    env_as(DAO, T0);
    g.create_plan(pay_vendor(3));
}

#[test]
#[should_panic(expected = "NOT_WHITELISTED")]
fn a_plan_cannot_pay_a_receiver_outside_the_whitelist() {
    // §11.11.2. A plan pays with no vote at run time, which an agent can only do for a whitelisted receiver.
    let mut g = setup();
    create(&mut g, plan_of(PlanAction::Transfer { receiver_id: id(STRANGER) }, NEAR, 3));
}

#[test]
#[should_panic(expected = "OVER_PER_TX")]
fn a_plan_cannot_start_over_the_limit_an_agent_faces() {
    let mut g = setup();
    create(&mut g, plan_of(PlanAction::Transfer { receiver_id: id(VENDOR) }, 6 * NEAR, 3));
}

#[test]
fn a_new_plan_waits_for_its_start_time_and_reads_as_section_4_11() {
    let mut g = setup();
    let plan_id = create(&mut g, pay_vendor(3));
    assert_eq!(plan_id, 0);
    let json = near_sdk::serde_json::to_value(plan(&g, 0)).unwrap();
    assert_eq!(json["action"], near_sdk::serde_json::json!({ "type": "transfer", "receiver_id": VENDOR }));
    assert_eq!(json["status"], "active");
    assert_eq!(json["pause_reason"], Value::Null);
    assert_eq!(json["next_run_at"], (T0 + MINUTE).to_string());
    assert_eq!(json["amount_per_run"], NEAR.to_string());
    assert_eq!(json["runs_done"], 0);
}

#[test]
fn a_swap_plan_parses_now_that_it_can_run() {
    // GĐ31 added `swap`: it must parse, with the fields the dashboard sends.
    let input = near_sdk::serde_json::json!({
        "action": { "type": "swap", "pool_id": 1, "token_out": "wrap.testnet", "max_slippage_bps": 50 },
        "strategy_id": "dca", "token_in": "", "amount_per_run": "1", "interval_sec": 60, "runs_total": 1, "start_at": "0",
    });
    assert!(near_sdk::serde_json::from_value::<PlanInput>(input).is_ok());
}

#[test]
fn get_plans_pages_in_id_order() {
    let mut g = setup();
    for _ in 0..3 {
        create(&mut g, pay_vendor(1));
    }
    let ids: Vec<u32> = g.get_plans(Some(1), Some(5)).iter().map(|p| p.plan_id).collect();
    assert_eq!(ids, [1, 2]);
    assert_eq!(g.get_plans(None, Some(1)).len(), 1);
    assert!(g.get_plan(9).is_none());
}

#[test]
#[should_panic(expected = "PLAN_NOT_DUE")]
fn a_step_before_its_time_is_refused() {
    // K2: only the due step runs, or anyone could spend a plan's budget early.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    step(&mut g, T0 + MINUTE - 1, 0);
}

#[test]
#[should_panic(expected = "PLAN_NOT_DUE")]
fn a_second_call_in_the_same_slot_is_refused_before_the_first_settles() {
    // K2: the callbacks of the first call have not run yet, so the slot itself must be what stops this.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    step(&mut g, T0 + MINUTE, 0);
    step(&mut g, T0 + MINUTE, 0);
}

#[test]
fn every_caller_gets_the_same_step() {
    // K1 and K2: if some caller got a different result, that caller would hold a right, and the keeper key would
    // stop being unprivileged.
    let run_as = |caller: &str| {
        let mut g = setup();
        create(&mut g, pay_vendor(3));
        env_as(caller, T0 + MINUTE);
        let _ = g.execute_plan_step(0);
        (calls(), plan(&g, 0), rec(&g, &step_id(0, T0 + MINUTE)))
    };
    assert_eq!(run_as(STRANGER), run_as(AGENT));
    assert_eq!(run_as(STRANGER), run_as(DAO));
}

#[test]
fn a_transfer_step_is_a_proposal_the_guard_approves_itself() {
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
    step(&mut g, due, 0);
    let add = calls().into_iter().find(|c| c.1 == "add_proposal").unwrap();
    assert_eq!((add.0.as_str(), add.2), (DAO, BOND));
    let proposal = &add.3["proposal"];
    assert_eq!(proposal["kind"]["Transfer"]["receiver_id"], VENDOR);
    assert_eq!(proposal["kind"]["Transfer"]["amount"], NEAR.to_string());
    // Key Doctor renders this line as a Guard note, so it must keep the shape of an agent request.
    let line = format!("[KD-GUARD] request={rid} agent={GUARD} decision=auto reasons=- memo=plan 0 run 1");
    assert_eq!(proposal["description"], line);
    assert_eq!(rec(&g, &rid).plan_id, Some(0));

    added(&mut g, due, &rid, Ok(7));
    let vote = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!(vote.3["id"], 7);
    assert_eq!(vote.3["action"], "VoteApprove");
    assert_eq!(vote.3["proposal"]["Transfer"]["amount"], NEAR.to_string(), "the vote must name the same kind");
    voted(&mut g, due, &rid, Ok(()));
    assert_eq!(plan(&g, 0).runs_done, 1);
    assert_eq!(rec(&g, &rid).status, RequestStatus::AutoApproved);
}

#[test]
fn a_call_step_runs_the_stored_call_and_counts_against_the_limit() {
    // Spec: every step counts `amount_per_run`, a `call` too, or a call plan would have no spending cap.
    let mut g = setup();
    create(&mut g, plan_of(pool_call(), NEAR, 3));
    let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
    step(&mut g, due, 0);
    assert_eq!(spent(&g), NEAR);
    let add = calls().into_iter().find(|c| c.1 == "add_proposal").unwrap();
    let call = &add.3["proposal"]["kind"]["FunctionCall"];
    assert_eq!(call["receiver_id"], "pool.testnet");
    assert_eq!(call["actions"][0]["method_name"], "deposit");
    assert_eq!(call["actions"][0]["args"], "eyJ0byI6MX0=");
    assert_eq!(call["actions"][0]["deposit"], (NEAR / 100).to_string());
    assert_eq!(call["actions"][0]["gas"], "30000000000000");

    added(&mut g, due, &rid, Ok(7));
    let vote = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!(vote.3["proposal"]["FunctionCall"], *call, "the vote must name the same kind");
}

#[test]
fn a_plan_ends_after_exactly_its_runs() {
    let mut g = setup();
    create(&mut g, pay_vendor(2));
    let first = T0 + MINUTE;
    paid_step(&mut g, first, 0, 1);
    assert_eq!(due_at(&g, 0), first + MINUTE);
    assert_eq!(plan(&g, 0).status, PlanStatus::Active);
    paid_step(&mut g, first + MINUTE, 0, 2);
    assert!(logged("plan_completed"));
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.status, p.next_run_at), (2, PlanStatus::Completed, None));
}

#[test]
#[should_panic(expected = "PLAN_NOT_ACTIVE")]
fn a_completed_plan_does_not_pay_again() {
    let mut g = setup();
    create(&mut g, pay_vendor(1));
    paid_step(&mut g, T0 + MINUTE, 0, 1);
    step(&mut g, T0 + 2 * MINUTE, 0);
}

#[test]
fn a_day_over_the_limit_skips_the_slot_and_keeps_the_run() {
    // §11.11.3 (2). The owner asked for `runs_total` payments, so a full day delays one and does not lose it.
    let mut g = setup();
    for i in 0..4 {
        auto_approved(&mut g, T0 + 1, &format!("req-000{i}"), 4 * NEAR, i);
    }
    create(&mut g, plan_of(PlanAction::Transfer { receiver_id: id(VENDOR) }, 5 * NEAR, 3));
    let due = T0 + MINUTE;
    step(&mut g, due, 0);
    assert!(logged("plan_step_skipped") && logged("OVER_DAILY_LIMIT"));
    assert!(!method_called("add_proposal"), "a skip must not spend");
    assert_eq!(spent(&g), 16 * NEAR);
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.status, p.next_run_at), (0, PlanStatus::Active, Some(U64(due + MINUTE))));

    let tomorrow = T0 + policy::DAY_NS + 1;
    step(&mut g, tomorrow, 0);
    assert!(method_called("add_proposal"), "the run still happens once the window rolls");
}

#[test]
fn a_late_step_runs_once_and_does_not_catch_up() {
    // The cron can be down for hours; the missed slots must not pay in a row afterwards.
    let mut g = setup();
    create(&mut g, pay_vendor(5));
    let due = T0 + MINUTE;
    step(&mut g, due + 90 * MINUTE + 1, 0);
    assert_eq!(due_at(&g, 0), due + 91 * MINUTE);
}

#[test]
fn a_guard_short_of_near_for_the_bond_pauses_the_plan() {
    // §11.11.3 (3). Sending the proposal would fail and could eat into the Guard's reserve.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    let due = T0 + MINUTE;
    env_full(STRANGER, due, 0, NEAR);
    let _ = g.execute_plan_step(0);
    assert!(!method_called("add_proposal"));
    assert!(logged("plan_paused"));
    let p = plan(&g, 0);
    assert_eq!((p.status, p.pause_reason), (PlanStatus::Paused, Some(PlanPauseReason::GuardLowNear)));
    assert_eq!(p.next_run_at, Some(U64(due)), "the slot stays, so Resume runs it");
    assert_eq!(spent(&g), 0);
}

#[test]
fn a_receiver_taken_off_the_whitelist_stops_the_plan() {
    // The owner's later decision wins over the plan. A skip would retry forever; only the owner can settle this.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    env_as(DAO, T0);
    g.remove_whitelist(id(VENDOR));
    step(&mut g, T0 + MINUTE, 0);
    assert!(!method_called("add_proposal"), "no payment to a removed receiver");
    assert!(logged("NOT_WHITELISTED"));
    assert_eq!(plan(&g, 0).pause_reason, Some(PlanPauseReason::Failures));
}

#[test]
fn a_limit_lowered_under_the_run_stops_the_plan() {
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    env_as(DAO, T0);
    g.set_policy(GuardPolicy { max_per_tx: U128(NEAR / 2), ..limits() });
    step(&mut g, T0 + MINUTE, 0);
    assert!(!method_called("add_proposal"));
    assert_eq!(plan(&g, 0).pause_reason, Some(PlanPauseReason::Failures));
}

#[test]
#[should_panic(expected = "PAUSED")]
fn the_guards_own_pause_stops_plans_too() {
    // The guardian's brake must hold for every spending path.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    env_as(GUARDIAN, T0);
    g.pause();
    step(&mut g, T0 + MINUTE, 0);
}

#[test]
fn a_refused_proposal_gives_back_the_limit_and_pauses() {
    // The DAO refused the proposal: nothing paid, and a top-up would not help, so the reason must not say balance.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    let due = T0 + MINUTE;
    step(&mut g, due, 0);
    assert_eq!(spent(&g), NEAR);
    added(&mut g, due, &step_id(0, due), Err(PromiseError::Failed));
    assert_eq!(spent(&g), 0, "no money left");
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.pause_reason), (0, Some(PlanPauseReason::Failures)));
}

#[test]
fn a_failed_vote_pauses_for_balance_and_resume_runs_it_again() {
    // UC18: the DAO is short of NEAR, so the vote fails with the payment. After a top-up the plan carries on.
    let mut g = setup();
    create(&mut g, pay_vendor(2));
    let due = T0 + MINUTE;
    step(&mut g, due, 0);
    added(&mut g, due, &step_id(0, due), Ok(1));
    voted(&mut g, due, &step_id(0, due), Err(PromiseError::Failed));
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.pause_reason), (0, Some(PlanPauseReason::InsufficientBalance)));
    assert_eq!(spent(&g), 0);

    env_as(DAO, due + 1);
    g.resume_plan(0);
    let retry = due + MINUTE;
    paid_step(&mut g, retry, 0, 2);
    assert_eq!(plan(&g, 0).runs_done, 1, "the failed run does not count");
    assert_eq!(rec(&g, &step_id(0, due)).status, RequestStatus::Failed, "its record stays");
}

#[test]
fn a_failed_vote_on_a_call_does_not_tell_the_owner_to_top_up() {
    // Sandbox: a role without `call:VoteApprove` fails here, with the DAO's balance fine.
    let mut g = setup();
    create(&mut g, plan_of(pool_call(), NEAR, 2));
    let due = T0 + MINUTE;
    step(&mut g, due, 0);
    added(&mut g, due, &step_id(0, due), Ok(1));
    voted(&mut g, due, &step_id(0, due), Err(PromiseError::Failed));
    assert_eq!(plan(&g, 0).pause_reason, Some(PlanPauseReason::Failures));
}

#[test]
fn a_proposal_that_fails_later_takes_the_run_back_and_reopens_the_plan() {
    // The vote landed but the payment did not. Without this the owner would get one payment fewer, with a plan
    // that says completed.
    let mut g = setup();
    create(&mut g, pay_vendor(1));
    let due = T0 + MINUTE;
    paid_step(&mut g, due, 0, 1);
    assert_eq!(plan(&g, 0).status, PlanStatus::Completed);
    synced(&mut g, due + 5, &step_id(0, due), "Failed", due);
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.status, p.pause_reason), (0, PlanStatus::Paused, Some(PlanPauseReason::Failures)));
    assert_eq!(p.next_run_at, Some(U64(due + 5)), "a paused plan needs a slot for Resume");
    assert_eq!(spent(&g), 0);
}

#[test]
fn a_run_counts_once_however_sync_and_the_vote_interleave() {
    // sync_request is public, so it can land before on_voted, or after it.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    let due = T0 + MINUTE;
    let rid = step_id(0, due);
    step(&mut g, due, 0);
    added(&mut g, due, &rid, Ok(1));
    synced(&mut g, due, &rid, "Approved", due);
    voted(&mut g, due, &rid, Ok(()));
    assert_eq!(plan(&g, 0).runs_done, 1);

    let next = due + MINUTE;
    paid_step(&mut g, next, 0, 2);
    synced(&mut g, next, &step_id(0, next), "Approved", next);
    assert_eq!(plan(&g, 0).runs_done, 2);
}

#[test]
#[should_panic(expected = "PLAN_NOT_ACTIVE")]
fn a_plan_the_owner_paused_does_not_run() {
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    env_as(DAO, T0);
    g.pause_plan(0);
    step(&mut g, T0 + MINUTE, 0);
}

#[test]
fn resume_runs_the_due_step_once() {
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    env_as(DAO, T0);
    g.pause_plan(0);
    assert_eq!(plan(&g, 0).pause_reason, Some(PlanPauseReason::Owner));
    env_as(DAO, T0 + 30 * MINUTE);
    g.resume_plan(0);
    let p = plan(&g, 0);
    assert_eq!((p.status, p.pause_reason), (PlanStatus::Active, None));
    step(&mut g, T0 + 30 * MINUTE, 0);
    assert!(method_called("add_proposal"));
    assert_eq!(due_at(&g, 0), T0 + 31 * MINUTE);
}

#[test]
fn a_late_failure_leaves_the_owners_pause_and_cancel_in_place() {
    // A step in flight when the owner acts must not undo that choice.
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    let due = T0 + MINUTE;
    paid_step(&mut g, due, 0, 1);
    env_as(DAO, due + 1);
    g.pause_plan(0);
    synced(&mut g, due + 2, &step_id(0, due), "Failed", due);
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.pause_reason), (0, Some(PlanPauseReason::Owner)));

    env_as(DAO, due + 3);
    g.cancel_plan(0);
    let p = plan(&g, 0);
    assert_eq!((p.status, p.next_run_at, p.pause_reason), (PlanStatus::Cancelled, None, None));
}

#[test]
fn a_step_in_flight_when_cancelled_counts_but_does_not_complete_the_plan() {
    let mut g = setup();
    create(&mut g, pay_vendor(1));
    let due = T0 + MINUTE;
    step(&mut g, due, 0);
    env_as(DAO, due);
    g.cancel_plan(0);
    added(&mut g, due, &step_id(0, due), Ok(1));
    voted(&mut g, due, &step_id(0, due), Ok(()));
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.status), (1, PlanStatus::Cancelled));
}

#[test]
#[should_panic(expected = "PLAN_ENDED")]
fn an_ended_plan_cannot_be_cancelled() {
    let mut g = setup();
    create(&mut g, pay_vendor(1));
    paid_step(&mut g, T0 + MINUTE, 0, 1);
    env_as(DAO, T0 + 2 * MINUTE);
    g.cancel_plan(0);
}

#[test]
#[should_panic(expected = "PLAN_NOT_PAUSED")]
fn only_a_paused_plan_resumes() {
    let mut g = setup();
    create(&mut g, pay_vendor(1));
    env_as(DAO, T0);
    g.resume_plan(0);
}

#[test]
#[should_panic(expected = "UNKNOWN_PLAN")]
fn an_unknown_plan_is_refused() {
    let mut g = setup();
    step(&mut g, T0, 9);
}

// ---- DCA swap step (GĐ31 S1, ADR 0007 / plan Change 1.3 and 1.5)

const EXCHANGE: &str = "ref-finance-101.testnet";
const WRAP: &str = "wrap.testnet";
const USDT: &str = "usdt.fakes.testnet";

fn swap_of(bps: u16) -> PlanAction {
    PlanAction::Swap { pool_id: 57, token_out: id(USDT), max_slippage_bps: bps }
}

/// A DCA plan: sells 0.1 NEAR per run.
fn dca(bps: u16, runs: u32) -> PlanInput {
    plan_of(swap_of(bps), NEAR / 10, runs)
}

fn quoted(g: &mut Guard, now: u64, rid: &str, plan_id: u32, quote: Result<u128, PromiseError>) {
    env_as(GUARD, now);
    let _ = g.on_quote(rid.into(), plan_id, quote.map(U128));
}

/// The `kind` of the proposal `on_quote` created.
fn swap_proposal_kind() -> Value {
    calls().into_iter().find(|c| c.1 == "add_proposal").unwrap().3["proposal"]["kind"].clone()
}

fn decoded(v: &Value) -> Value {
    let bytes: near_sdk::json_types::Base64VecU8 = near_sdk::serde_json::from_value(v.clone()).unwrap();
    near_sdk::serde_json::from_slice(&bytes.0).unwrap()
}

/// `min_amount_out` of the swap message inside a swap kind.
fn min_out_of(kind: &Value) -> Value {
    let args = decoded(&kind["FunctionCall"]["actions"][1]["args"]);
    let msg: Value = near_sdk::serde_json::from_str(args["msg"].as_str().unwrap()).unwrap();
    msg["actions"][0]["min_amount_out"].clone()
}

#[test]
fn a_swap_step_asks_rhea_for_a_quote_before_any_proposal_exists() {
    // The proposal's `min_amount_out` comes from the price at run time, so no `add_proposal` may precede the quote.
    let mut g = setup();
    create(&mut g, dca(100, 2));
    let due = T0 + MINUTE;
    step(&mut g, due, 0);
    assert!(!method_called("add_proposal"), "no proposal before the quote");
    let quote = calls().into_iter().find(|c| c.1 == "get_return").unwrap();
    assert_eq!(quote.0, EXCHANGE, "the exchange is the network constant, never a caller's choice");
    assert_eq!(
        quote.3,
        near_sdk::serde_json::json!({
            "pool_id": 57, "token_in": WRAP, "amount_in": (NEAR / 10).to_string(), "token_out": USDT,
        })
    );
    assert!(method_called("on_quote"));
    // The slot moved and the run is counted in the first receipt, as for every step (K2).
    assert_eq!(spent(&g), NEAR / 10);
    assert_eq!(due_at(&g, 0), due + MINUTE);
    let r = rec(&g, &step_id(0, due));
    assert_eq!((r.receiver_id.as_str(), r.amount.0, r.plan_id), (WRAP, NEAR / 10, Some(0)));
}

#[test]
fn a_swap_step_gives_every_caller_the_same_receipts() {
    // K1: the keeper passes only a plan id; whoever calls, the contracts and amounts are the same.
    let run_as = |caller: &str| {
        let mut g = setup();
        create(&mut g, dca(100, 2));
        env_as(caller, T0 + MINUTE);
        let _ = g.execute_plan_step(0);
        (calls(), plan(&g, 0))
    };
    assert_eq!(run_as(STRANGER), run_as(AGENT));
}

#[test]
fn a_failed_quote_pauses_with_quote_failed_not_add_proposal_failed_and_gives_the_limit_back() {
    // Plan 1.5 row 2. Two causes need two codes: a dead quote is the pool's problem (retry later), a refused
    // add_proposal is the DAO's. `finish` alone would label it ADD_PROPOSAL_FAILED.
    for quote in [Err(PromiseError::Failed), Ok(0)] {
        let mut g = setup();
        create(&mut g, dca(100, 2));
        let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
        step(&mut g, due, 0);
        assert_eq!(spent(&g), NEAR / 10);
        quoted(&mut g, due, &rid, 0, quote);
        let p = plan(&g, 0);
        assert_eq!((p.status, p.pause_reason, p.runs_done), (PlanStatus::Paused, Some(PlanPauseReason::Failures), 0));
        assert_eq!(p.next_run_at, Some(U64(due + MINUTE)), "Resume needs a slot");
        assert!(logged("QUOTE_FAILED"));
        assert!(!logged("ADD_PROPOSAL_FAILED"), "the first code wins");
        assert_eq!(rec(&g, &rid).status, RequestStatus::Failed);
        assert_eq!(spent(&g), 0, "nothing moved, so the daily window is given back");
        assert!(!method_called("add_proposal"), "no proposal on a dead quote");
    }
}

#[test]
fn a_failed_quote_leaves_the_owners_pause_in_place() {
    // A step in flight when the owner paused must not turn the owner's pause into a Failures pause.
    let mut g = setup();
    create(&mut g, dca(100, 2));
    let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
    step(&mut g, due, 0);
    env_as(DAO, due);
    g.pause_plan(0);
    quoted(&mut g, due, &rid, 0, Ok(0));
    assert_eq!(plan(&g, 0).pause_reason, Some(PlanPauseReason::Owner));
}

#[test]
fn a_good_quote_sets_min_out_to_the_exact_floor_of_quote_times_the_kept_share() {
    // The owner chose a max price drop: the swap must refuse anything under quote * (10000 - bps) / 10000, rounded
    // DOWN (rounding up could refuse the quoted price itself).
    // 12_345 * 9950 / 10_000 = 12_283.275 -> 12_283 (ceil would be 12_284); 12_345 * 9800 / 10_000 = 12_098.1.
    for (bps, quote, want) in [
        (100u16, 1_000_000u128, 990_000u128),
        (50, 12_345, 12_283),
        (200, 12_345, 12_098),
        (100, 1, 0), // 1 * 9900 / 10000 = 0: floor, never rounds up to the whole quote
    ] {
        let mut g = setup();
        create(&mut g, dca(bps, 2));
        let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
        step(&mut g, due, 0);
        quoted(&mut g, due, &rid, 0, Ok(quote));
        assert_eq!(min_out_of(&swap_proposal_kind()), want.to_string(), "bps {bps} quote {quote}");
    }
}

#[test]
fn min_out_does_not_overflow_on_a_quote_near_u128_max() {
    // quote * 9950 would overflow u128 (and the contract builds with overflow-checks); the result must still be the
    // exact floor. Constants computed with arbitrary-precision integers.
    for (bps, want) in [
        (50u16, "338580955086333771146057734394609370397"),
        (100, "336879543251729078828740861357450529340"),
        (200, "333476719582519694194107115283132847225"),
    ] {
        let mut g = setup();
        create(&mut g, dca(bps, 2));
        let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
        step(&mut g, due, 0);
        quoted(&mut g, due, &rid, 0, Ok(u128::MAX));
        assert_eq!(min_out_of(&swap_proposal_kind()), want, "bps {bps}");
    }
}

#[test]
fn a_good_quote_builds_the_wrap_then_swap_proposal_and_the_guard_votes_on_the_same_kind() {
    let mut g = setup();
    create(&mut g, dca(100, 2));
    let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
    step(&mut g, due, 0);
    quoted(&mut g, due, &rid, 0, Ok(896_500));

    let add = calls().into_iter().find(|c| c.1 == "add_proposal").unwrap();
    assert_eq!((add.0.as_str(), add.2), (DAO, BOND));
    let line = format!("[KD-GUARD] request={rid} agent={GUARD} decision=auto reasons=- memo=plan 0 run 1");
    assert_eq!(add.3["proposal"]["description"], line);
    let call = &add.3["proposal"]["kind"]["FunctionCall"];
    assert_eq!(call["receiver_id"], WRAP, "wNEAR is the receiver of both actions");
    let acts = call["actions"].as_array().unwrap();
    assert_eq!(acts.len(), 2);

    // 1. wrap exactly the run's NEAR
    assert_eq!(acts[0]["method_name"], "near_deposit");
    assert_eq!(acts[0]["deposit"], (NEAR / 10).to_string(), "deposit == amount_per_run: the daily limit counts it");
    assert_eq!(decoded(&acts[0]["args"]), near_sdk::serde_json::json!({}));
    assert_eq!(acts[0]["gas"], dao::GAS_NEAR_DEPOSIT.as_gas().to_string());

    // 2. ft_transfer_call to the exchange, 1 yocto, with the swap message
    assert_eq!(acts[1]["method_name"], "ft_transfer_call");
    assert_eq!(acts[1]["deposit"], "1", "NEP-141 needs exactly 1 yocto");
    assert_eq!(acts[1]["gas"], dao::GAS_FT_TRANSFER_CALL.as_gas().to_string());
    let args = decoded(&acts[1]["args"]);
    assert_eq!(args["receiver_id"], EXCHANGE);
    assert_eq!(args["amount"], (NEAR / 10).to_string());
    let msg: Value = near_sdk::serde_json::from_str(args["msg"].as_str().unwrap()).unwrap();
    // 896_500 * 9900 / 10_000 = 887_535
    assert_eq!(
        msg,
        near_sdk::serde_json::json!({ "actions": [{
            "pool_id": 57, "token_in": WRAP, "token_out": USDT,
            "amount_in": (NEAR / 10).to_string(), "min_amount_out": "887535",
        }]})
    );
    assert!(!logged("plan_paused"));

    // The vote must carry the SAME kind: the DAO compares it with the stored proposal.
    let kind = swap_proposal_kind();
    env_as(GUARD, due);
    let _ = g.on_proposal_added(rid.clone(), Some(kind.clone()), Ok(9));
    let vote = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!((vote.3["id"].as_u64(), vote.3["action"].as_str()), (Some(9), Some("VoteApprove")));
    assert_eq!(vote.3["proposal"], kind);
    voted(&mut g, due, &rid, Ok(()));
    assert_eq!(plan(&g, 0).runs_done, 1);
    assert_eq!(rec(&g, &rid).status, RequestStatus::AutoApproved);
}

#[test]
fn the_vote_uses_the_kind_it_is_given_and_without_one_rebuilds_from_the_plan() {
    // With `Some(kind)` (swap): the plan cannot rebuild it, so the argument is the only source.
    let due = T0 + MINUTE;
    let mut g = setup();
    create(&mut g, dca(100, 2));
    step(&mut g, due, 0);
    let given = near_sdk::serde_json::json!({ "Transfer": { "receiver_id": "elsewhere.testnet", "token_id": "", "amount": "7", "msg": null } });
    env_as(GUARD, due);
    let _ = g.on_proposal_added(step_id(0, due), Some(given.clone()), Ok(3));
    let vote = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!(vote.3["proposal"], given);

    // With `None` (also what a callback in flight at the upgrade carries): as before GĐ31. A transfer plan votes
    // the transfer from its stored plan...
    let mut g = setup();
    create(&mut g, pay_vendor(2));
    step(&mut g, due, 0);
    added(&mut g, due, &step_id(0, due), Ok(4));
    let vote = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!(vote.3["proposal"]["Transfer"]["receiver_id"], VENDOR);
    // ...a call plan votes its call...
    let mut g = setup();
    create(&mut g, plan_of(pool_call(), NEAR, 2));
    step(&mut g, due, 0);
    added(&mut g, due, &step_id(0, due), Ok(6));
    let vote = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!(vote.3["proposal"]["FunctionCall"]["receiver_id"], "pool.testnet");
    // ...and so does an agent request with no plan.
    let mut g = setup();
    ask(&mut g, T0, "req-0001", VENDOR, NEAR);
    added(&mut g, T0, "req-0001", Ok(5));
    let vote = calls().into_iter().find(|c| c.1 == "act_proposal").unwrap();
    assert_eq!(vote.3["proposal"]["Transfer"]["amount"], NEAR.to_string());
}

#[test]
fn the_swap_vote_gets_the_swap_gas_and_a_transfer_vote_keeps_its_own() {
    // A swap's act_proposal holds near_deposit + F; giving it the transfer gas would fail every run at the vote.
    let due = T0 + MINUTE;
    let gas_of_vote = |g: &mut Guard, kind: Option<Value>, rid: &str| {
        env_as(GUARD, due);
        let _ = g.on_proposal_added(rid.into(), kind, Ok(1));
        get_created_receipts()
            .into_iter()
            .find(|r| r.receiver_id == id(DAO))
            .and_then(|r| {
                r.actions.into_iter().find_map(|a| match a {
                    MockAction::FunctionCallWeight { prepaid_gas, .. } => Some(prepaid_gas.as_gas()),
                    _ => None,
                })
            })
            .unwrap()
    };
    let mut g = setup();
    create(&mut g, dca(100, 2));
    step(&mut g, due, 0);
    let swap_gas = gas_of_vote(&mut g, Some(near_sdk::serde_json::json!({})), &step_id(0, due));
    let mut g = setup();
    create(&mut g, pay_vendor(2));
    step(&mut g, due, 0);
    let transfer_gas = gas_of_vote(&mut g, None, &step_id(0, due));
    assert_eq!(swap_gas, GAS_ACT_PROPOSAL_SWAP.as_gas());
    assert_eq!(transfer_gas, GAS_ACT_PROPOSAL.as_gas());
    assert!(swap_gas >= dao::GAS_NEAR_DEPOSIT.as_gas() + dao::GAS_FT_TRANSFER_CALL.as_gas());
}

#[test]
fn a_failed_vote_on_a_swap_pauses_for_balance_and_gives_the_limit_back() {
    // The DAO is short of NEAR: near_deposit fails inside act_proposal, so the vote fails (F4). Like a transfer, the
    // owner is told to top up (a call would say Failures), and the NEAR counted for the run goes back.
    let mut g = setup();
    create(&mut g, dca(100, 2));
    let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
    step(&mut g, due, 0);
    quoted(&mut g, due, &rid, 0, Ok(896_500));
    let kind = swap_proposal_kind();
    env_as(GUARD, due);
    let _ = g.on_proposal_added(rid.clone(), Some(kind), Ok(1));
    voted(&mut g, due, &rid, Err(PromiseError::Failed));
    let p = plan(&g, 0);
    assert_eq!((p.status, p.pause_reason, p.runs_done), (PlanStatus::Paused, Some(PlanPauseReason::InsufficientBalance), 0));
    assert!(logged("VOTE_FAILED"));
    assert_eq!(spent(&g), 0);
    assert_eq!(rec(&g, &rid).status, RequestStatus::Failed);
}

#[test]
fn a_refused_swap_at_rhea_still_counts_the_run() {
    // D2 (owner accepted): the vote passed and Sputnik shows Approved, so sync reads Executed and the run stays
    // counted; the NEAR sits in the DAO as wNEAR.
    let mut g = setup();
    create(&mut g, dca(100, 1));
    let (due, rid) = (T0 + MINUTE, step_id(0, T0 + MINUTE));
    step(&mut g, due, 0);
    quoted(&mut g, due, &rid, 0, Ok(896_500));
    let kind = swap_proposal_kind();
    env_as(GUARD, due);
    let _ = g.on_proposal_added(rid.clone(), Some(kind), Ok(1));
    voted(&mut g, due, &rid, Ok(()));
    synced(&mut g, due + 5, &rid, "Approved", due);
    let p = plan(&g, 0);
    assert_eq!((p.runs_done, p.status), (1, PlanStatus::Completed));
    assert_eq!(spent(&g), NEAR / 10);
}

// `#[private]` is enforced by the wasm entry point the macro generates, so a native unit test cannot see it:
// tests/sandbox.rs `on_quote_cannot_be_called_by_anyone_but_the_guard` covers it.

#[test]
#[should_panic(expected = "NOT_A_SWAP_PLAN")]
fn on_quote_only_serves_a_swap_plan() {
    let mut g = setup();
    create(&mut g, pay_vendor(2));
    step(&mut g, T0 + MINUTE, 0);
    quoted(&mut g, T0 + MINUTE, &step_id(0, T0 + MINUTE), 0, Ok(1));
}

#[test]
#[should_panic(expected = "OVER_PER_TX")]
fn a_swap_plan_cannot_start_over_the_per_tx_limit() {
    // A DCA plan must not sell more per run than an agent could move.
    let mut g = setup();
    create(&mut g, plan_of(swap_of(100), 6 * NEAR, 2));
}

#[test]
#[should_panic(expected = "OVER_DAILY_LIMIT")]
fn a_swap_plan_cannot_start_over_the_daily_limit() {
    let mut g = setup();
    env_as(DAO, T0);
    g.set_policy(GuardPolicy { max_per_tx: U128(30 * NEAR), ..limits() });
    create(&mut g, plan_of(swap_of(100), 21 * NEAR, 2));
}

#[test]
#[should_panic(expected = "INVALID_SLIPPAGE")]
fn create_plan_refuses_a_slippage_outside_the_three_choices() {
    let mut g = setup();
    create(&mut g, dca(75, 2));
}

#[test]
#[should_panic(expected = "INVALID_TOKEN_OUT")]
fn create_plan_refuses_wnear_as_the_token_to_buy() {
    let mut g = setup();
    create(&mut g, plan_of(PlanAction::Swap { pool_id: 57, token_out: id(WRAP), max_slippage_bps: 100 }, NEAR / 10, 2));
}

#[test]
fn a_swap_over_the_daily_limit_skips_the_slot_without_a_quote() {
    // A skip must not spend a view or count money. (Plan 1.5 row 1.)
    let mut g = setup();
    for i in 0..4 {
        auto_approved(&mut g, T0 + 1, &format!("req-000{i}"), 5 * NEAR, i);
    }
    create(&mut g, plan_of(swap_of(100), NEAR, 2));
    step(&mut g, T0 + MINUTE, 0);
    assert!(logged("OVER_DAILY_LIMIT"));
    assert!(!method_called("get_return") && !method_called("add_proposal"));
    assert_eq!(spent(&g), 20 * NEAR);
}

#[test]
fn the_guard_reports_version_1_4_0() {
    // The dashboard and the upgrade script read this to know which Guard a Budget runs.
    let g = setup();
    assert_eq!(g.kd_guard_info()["version"], "1.4.0");
}

// ---- close (issue #81)

fn close_as(g: &mut Guard, who: &str) {
    env_as(who, T0 + 2 * MINUTE);
    let _ = g.close();
}

/// (receiver, beneficiary) of every DeleteAccount the current context created.
fn deletes() -> Vec<(String, String)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::DeleteAccount { beneficiary_id, .. } => Some((to.clone(), beneficiary_id.to_string())),
                _ => None,
            })
        })
        .collect()
}

#[test]
fn close_deletes_the_guard_with_the_dao_as_beneficiary_and_clears_its_records() {
    // The DAO gets the whole balance back, the locked storage included. NEAR refuses to delete an account with
    // over 10 KB of data, so every record must go first.
    let mut g = setup();
    auto_approved(&mut g, T0, "req-0001", NEAR, 7);
    ask(&mut g, T0, "req-0002", STRANGER, NEAR);
    added(&mut g, T0, "req-0002", Ok(8));
    synced(&mut g, T0 + 1, "req-0002", "Rejected", T0);
    let p = create(&mut g, pay_vendor(3));
    env_as(DAO, T0);
    g.cancel_plan(p);
    assert_eq!(g.get_config()["requests"], "2");

    close_as(&mut g, DAO);
    assert_eq!(deletes(), [(GUARD.to_string(), DAO.to_string())]);
    assert!(logged("guard_closed"));
    assert!(g.get_request("req-0001".into()).is_none() && g.get_request("req-0002".into()).is_none());
    assert!(g.get_request_by_proposal(7).is_none() && g.get_request_by_proposal(8).is_none());
    assert!(g.list_requests(None, None).is_empty() && g.get_plans(None, None).is_empty());
    assert!(g.get_agents().is_empty() && g.get_whitelist().is_empty());
    assert_eq!(g.get_config()["guardians"], json!([]));
}

#[test]
#[should_panic(expected = "ONLY_DAO")]
fn only_the_dao_may_close_the_guard() {
    // A guardian may stop the Guard, never take its money anywhere.
    let mut g = setup();
    close_as(&mut g, GUARDIAN);
}

#[test]
#[should_panic(expected = "OPEN_REQUESTS")]
fn close_waits_for_a_request_the_council_has_not_voted_on() {
    // Its proposal still points at the Guard's money; deleting now would leave the council voting on nothing.
    let mut g = setup();
    ask(&mut g, T0, "req-0001", STRANGER, NEAR);
    added(&mut g, T0, "req-0001", Ok(3));
    close_as(&mut g, DAO);
}

#[test]
#[should_panic(expected = "OPEN_PLANS")]
fn close_refuses_while_a_plan_is_active() {
    let mut g = setup();
    create(&mut g, pay_vendor(3));
    close_as(&mut g, DAO);
}

#[test]
#[should_panic(expected = "OPEN_PLANS")]
fn close_refuses_a_paused_plan_because_the_dao_could_resume_it() {
    let mut g = setup();
    let p = create(&mut g, pay_vendor(3));
    env_as(DAO, T0);
    g.pause_plan(p);
    close_as(&mut g, DAO);
}

#[test]
#[should_panic(expected = "TOO_MANY_RECORDS")]
fn close_refuses_a_guard_with_records_the_ring_no_longer_reaches() {
    // Records older than the last 200 cannot be found to delete, so the account would stay over the 10 KB limit.
    let mut g = setup();
    env_as(DAO, T0);
    g.set_policy(GuardPolicy { max_pending_per_agent: 1_000, ..limits() });
    for i in 0..201 {
        ask(&mut g, T0 + i, &format!("req-{i:05}"), VENDOR, NEAR / 1000);
        added(&mut g, T0 + i, &format!("req-{i:05}"), Ok(i));
        voted(&mut g, T0 + i, &format!("req-{i:05}"), Ok(()));
    }
    close_as(&mut g, DAO);
}
