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
    let _ = g.on_proposal_added(rid.into(), result);
}

fn voted(g: &mut Guard, now: u64, rid: &str, result: Result<(), PromiseError>) {
    env_as(GUARD, now);
    g.on_voted(rid.into(), result);
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
