// Unit tests: who can create, the name and DAO limits, the reservation and its release on every failure path,
// and the receipts `create` hands to the DAO and the new Guard. The sandbox test (tests/sandbox.rs) runs the
// real chain of promises against Sputnik.
use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const FACTORY: &str = "guard-factory.testnet";
const DAO: &str = "acme.sputnik-v2.testnet";
const OTHER_DAO: &str = "other.sputnik-v2.testnet";
const CODE: &[u8] = b"\0asm guard";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id(FACTORY))
        .predecessor_account_id(id(predecessor))
        .signer_account_id(id(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(150))
        .account_balance(NearToken::from_near(100));
    b
}

fn env_as(predecessor: &str, deposit: u128) {
    testing_env!(ctx(predecessor, deposit).build());
}

/// A callback run with one promise result, as the runtime would after the previous hop.
fn env_callback(result: PromiseResult) {
    testing_env!(
        ctx(FACTORY, 0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result]
    );
}

fn factory() -> Factory {
    env_as(FACTORY, 0);
    Factory::new(CODE.to_vec())
}

fn policy() -> GuardPolicy {
    GuardPolicy { max_per_tx: U128(NEAR), max_per_day: U128(5 * NEAR), max_pending_per_agent: 3, min_reserve: U128(NEAR / 2) }
}

fn agent(n: usize) -> AgentInput {
    AgentInput { account_id: id(&format!("agent{n}.testnet")), label: format!("agent {n}") }
}

fn create(f: &mut Factory, dao: &str, name: &str, deposit: u128) -> Promise {
    env_as(dao, deposit);
    f.create(name.into(), policy(), vec![agent(1)], vec![], vec![])
}

fn guard_id(name: &str) -> AccountId {
    id(&format!("{name}.{FACTORY}"))
}

/// Runs `create` and both callbacks as if every hop succeeded.
fn create_ok(f: &mut Factory, dao: &str, name: &str) {
    let _ = create(f, dao, name, 3 * NEAR);
    env_callback(PromiseResult::Successful(b"{}".to_vec()));
    let _ = f.on_dao_checked(guard_id(name), id(dao), U128(3 * NEAR), U128(2 * NEAR), json!({}));
    env_callback(PromiseResult::Successful(vec![]));
    assert!(f.on_created(guard_id(name), id(dao), U128(3 * NEAR)));
}

fn panic_message(f: impl FnOnce()) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

fn transfers_to(receiver: &str) -> Vec<u128> {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == id(receiver))
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .collect()
}

#[test]
fn new_publishes_the_guard_code_as_a_global_contract_and_keeps_its_hash() {
    let f = factory();
    assert_eq!(f.guard_code_hash, env::sha256_array(CODE));
    let published = get_created_receipts().into_iter().any(|r| {
        r.receiver_id == id(FACTORY) && r.actions.iter().any(|a| matches!(a, MockAction::DeployGlobalContract { .. }))
    });
    assert!(published, "Guards point at this hash; without the publish every create would fail");
}

#[test]
fn create_reserves_the_name_for_the_calling_dao_before_any_promise() {
    let mut f = factory();
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    let g = f.get_guard(guard_id("acme")).unwrap();
    assert_eq!(g.dao_id, id(DAO), "the caller is the DAO: nobody can create a Guard for another DAO");
    assert!(!g.ready);
    assert!(f.get_guards_for_dao(id(OTHER_DAO)).is_empty());
}

#[test]
fn create_first_asks_the_caller_for_its_dao_policy() {
    let mut f = factory();
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    let asked = get_created_receipts().into_iter().any(|r| {
        r.receiver_id == id(DAO)
            && r.actions.iter().any(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"get_policy"))
    });
    assert!(asked, "the get_policy view is what keeps plain accounts out of the registry");
}

#[test]
#[should_panic(expected = "NAME_TAKEN")]
fn a_name_cannot_be_taken_twice_even_by_another_dao() {
    let mut f = factory();
    create_ok(&mut f, DAO, "acme");
    let _ = create(&mut f, OTHER_DAO, "acme", 3 * NEAR);
}

#[test]
#[should_panic(expected = "NAME_TAKEN")]
fn a_name_still_being_created_is_taken() {
    let mut f = factory();
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
}

#[test]
fn the_eleventh_guard_of_one_dao_is_refused_but_other_daos_are_not_affected() {
    let mut f = factory();
    for i in 0..10 {
        create_ok(&mut f, DAO, &format!("g{i}"));
    }
    assert_eq!(f.get_guards_for_dao(id(DAO)).len(), 10);
    let msg = panic_message(|| {
        let _ = create(&mut f, DAO, "g10", 3 * NEAR);
    });
    assert!(msg.contains("TOO_MANY_GUARDS"), "MAX_GUARDS_PER_DAO bounds the storage one DAO can use: {msg}");
    create_ok(&mut f, OTHER_DAO, "other");
}

#[test]
fn invalid_names_are_refused() {
    for name in ["", "Acme", "a.b", "acme!", "-acme", "a--b", &"a".repeat(33)] {
        let mut f = factory();
        let msg = panic_message(|| {
            let _ = create(&mut f, DAO, name, 3 * NEAR);
        });
        assert!(msg.contains("INVALID_NAME"), "name {name:?} is not one label under the factory: {msg}");
    }
}

#[test]
#[should_panic(expected = "DEPOSIT_TOO_LOW")]
fn a_deposit_below_the_guard_floor_is_refused() {
    let mut f = factory();
    let _ = create(&mut f, DAO, "acme", NEAR / 10);
}

#[test]
#[should_panic(expected = "NOT_ENOUGH_GAS")]
fn a_short_gassed_create_fails_before_money_moves() {
    let mut f = factory();
    testing_env!(ctx(DAO, 3 * NEAR).prepaid_gas(Gas::from_tgas(50)).build());
    let _ = f.create("acme".into(), policy(), vec![], vec![], vec![]);
}

#[test]
#[should_panic(expected = "TOO_MANY_AGENTS")]
fn guard_input_limits_are_checked_before_money_moves() {
    let mut f = factory();
    env_as(DAO, 3 * NEAR);
    let _ = f.create("acme".into(), policy(), (0..11).map(agent).collect(), vec![], vec![]);
}

#[test]
#[should_panic(expected = "LABEL_TOO_LONG")]
fn long_labels_are_checked_before_money_moves() {
    let mut f = factory();
    env_as(DAO, 3 * NEAR);
    let w = WhitelistInput { account_id: id("vendor.testnet"), label: "x".repeat(65), max_per_tx: None };
    let _ = f.create("acme".into(), policy(), vec![], vec![w], vec![]);
}

#[test]
fn a_caller_that_is_not_a_dao_gets_its_deposit_back_and_no_record() {
    let mut f = factory();
    let _ = create(&mut f, "alice.testnet", "acme", 3 * NEAR);
    env_callback(PromiseResult::Failed);
    let _ = f.on_dao_checked(guard_id("acme"), id("alice.testnet"), U128(3 * NEAR), U128(2 * NEAR), json!({}));
    assert_eq!(transfers_to("alice.testnet"), vec![3 * NEAR]);
    assert!(f.get_guard(guard_id("acme")).is_none());
    assert!(f.get_guards_for_dao(id("alice.testnet")).is_empty());
}

#[test]
fn a_dao_gets_a_locked_guard_running_the_global_code_with_itself_as_dao_id() {
    let mut f = factory();
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    env_callback(PromiseResult::Successful(b"{}".to_vec()));
    let init = json!({ "dao_id": DAO });
    let _ = f.on_dao_checked(guard_id("acme"), id(DAO), U128(3 * NEAR), U128(2 * NEAR), init.clone());
    let actions: Vec<MockAction> =
        get_created_receipts().into_iter().filter(|r| r.receiver_id == guard_id("acme")).flat_map(|r| r.actions).collect();
    assert!(actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })));
    assert!(actions.iter().any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == 2 * NEAR)));
    assert!(actions.iter().any(|a| matches!(a, MockAction::UseGlobalContract { .. })));
    assert!(actions.iter().any(|a| matches!(a, MockAction::FunctionCallWeight { method_name, args, .. }
        if method_name == b"new" && args == &init.to_string().into_bytes())));
    assert!(
        !actions.iter().any(|a| matches!(a, MockAction::AddKeyWithFullAccess { .. } | MockAction::AddKeyWithFunctionCall { .. })),
        "a key on the Guard would let its holder redeploy it or drain it"
    );
}

#[test]
fn a_successful_create_marks_the_guard_ready_and_emits_guard_created() {
    let mut f = factory();
    create_ok(&mut f, DAO, "acme");
    assert!(f.get_guard(guard_id("acme")).unwrap().ready);
    let log = get_logs().into_iter().find(|l| l.contains("guard_created")).expect("event");
    assert!(log.contains(DAO) && log.contains(&format!("acme.{FACTORY}")));
    assert_eq!(f.list_guards(None, None).len(), 1);
}

#[test]
fn a_failed_guard_creation_refunds_the_whole_deposit_and_frees_the_name() {
    let mut f = factory();
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    env_callback(PromiseResult::Failed);
    assert!(!f.on_created(guard_id("acme"), id(DAO), U128(3 * NEAR)));
    assert_eq!(transfers_to(DAO), vec![3 * NEAR]);
    assert!(f.get_guard(guard_id("acme")).is_none());
    create_ok(&mut f, DAO, "acme");
}

#[test]
fn list_guards_pages_through_every_dao() {
    let mut f = factory();
    create_ok(&mut f, DAO, "a1");
    create_ok(&mut f, OTHER_DAO, "b1");
    create_ok(&mut f, DAO, "a2");
    let all: Vec<_> = f.list_guards(None, None).into_iter().map(|g| g.name).collect();
    assert_eq!(all, vec!["a1", "b1", "a2"]);
    let page: Vec<_> = f.list_guards(Some(1), Some(1)).into_iter().map(|g| g.name).collect();
    assert_eq!(page, vec!["b1"]);
    assert_eq!(f.get_guards_for_dao(id(DAO)).len(), 2);
}
