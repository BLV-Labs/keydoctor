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
        .prepaid_gas(Gas::from_tgas(300))
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
    AgentInput { account_id: id(&format!("agent{n}.testnet")), label: format!("agent {n}"), public_key: None }
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
fn new_stores_the_guard_code_and_its_hash_without_publishing_anything() {
    let f = factory();
    assert_eq!(f.guard_code_hash, env::sha256_array(CODE));
    assert_eq!(env::storage_read(GUARD_CODE_KEY).as_deref(), Some(CODE), "every create deploys this copy");
    // A global publish burns about 35 NEAR of the factory owner's money: only `publish_guard_code_global` does it.
    assert!(get_created_receipts().is_empty());
}

#[test]
fn the_deposit_must_also_pay_for_the_guards_copy_of_the_code() {
    // 2 NEAR of code storage at 10^19 yocto per byte. A fresh factory per call: a panic on chain rolls the
    // reservation back, the mocked env does not.
    let big = || {
        env_as(FACTORY, 0);
        Factory::new(vec![0; 200_000])
    };
    let mut f = big();
    let msg = panic_message(|| {
        let _ = create(&mut f, DAO, "acme", 2 * NEAR);
    });
    assert!(msg.contains("DEPOSIT_TOO_LOW"), "the factory must not pay for a DAO's Guard: {msg}");
    let mut f = big();
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    assert!(f.get_guard(guard_id("acme")).is_some());
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
fn a_dao_gets_a_locked_guard_running_its_own_copy_of_the_code_with_itself_as_dao_id() {
    let mut f = factory();
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    env_callback(PromiseResult::Successful(b"{}".to_vec()));
    let init = json!({ "dao_id": DAO });
    let _ = f.on_dao_checked(guard_id("acme"), id(DAO), U128(3 * NEAR), U128(2 * NEAR), init.clone());
    let actions: Vec<MockAction> =
        get_created_receipts().into_iter().filter(|r| r.receiver_id == guard_id("acme")).flat_map(|r| r.actions).collect();
    assert!(actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })));
    assert!(actions.iter().any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == 2 * NEAR)));
    assert!(actions.iter().any(|a| matches!(a, MockAction::DeployContract { code, .. } if code == CODE)));
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

#[test]
fn the_deposit_must_also_pay_each_agent_accounts_gas_fund() {
    // Otherwise the new Guard pays the funds out of the floor that keeps it running. The same deposit passes
    // with an unkeyed agent, so the fund is what refuses it.
    let deposit = 3 * NEAR / 4;
    let mut f = factory();
    let _ = create(&mut f, DAO, "plain", deposit);

    let mut f = factory();
    let mut keyed = agent(1);
    keyed.public_key = Some("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap());
    env_as(DAO, deposit);
    let msg = panic_message(|| {
        let _ = f.create("keyed".into(), policy(), vec![keyed], vec![], vec![]);
    });
    assert!(msg.contains("DEPOSIT_TOO_LOW"), "{msg}");
}

// ---- set_guard_code (GĐ31 S1, D1)

const NEW_CODE: &[u8] = b"\0asm guard 1.3.0 with a swap step";

#[test]
fn set_guard_code_replaces_the_code_hash_length_and_the_bytes_a_guard_upgrade_pulls() {
    // D1: this factory is the code source for `upgrade`, which hashes exactly the bytes `get_guard_code` returns
    // against what the DAO approved. A hash that moved without the bytes (or the reverse) would make every upgrade fail.
    let mut f = factory();
    let old_hash = f.get_code_hash();
    env_as(FACTORY, 0);
    f.set_guard_code(NEW_CODE.to_vec());
    assert_ne!(f.get_code_hash(), old_hash);
    assert_eq!(f.guard_code_hash, env::sha256_array(NEW_CODE));
    assert_eq!(f.guard_code_len, NEW_CODE.len() as u64);
    assert_ne!(NEW_CODE.len(), CODE.len(), "the fixture must tell a stale length from the new one");
    assert_eq!(env::storage_read(GUARD_CODE_KEY).as_deref(), Some(NEW_CODE));
    assert!(get_logs().iter().any(|l| l.contains("guard_code_set")), "indexers follow this event");
}

#[test]
fn create_after_set_guard_code_deploys_the_new_code_and_a_guard_made_before_keeps_the_old() {
    let mut f = factory();
    let deployed = |name: &str| -> Vec<u8> {
        get_created_receipts()
            .into_iter()
            .filter(|r| r.receiver_id == guard_id(name))
            .flat_map(|r| r.actions)
            .find_map(|a| match a {
                MockAction::DeployContract { code, .. } => Some(code),
                _ => None,
            })
            .expect("a deploy action")
    };
    let make = |f: &mut Factory, name: &str| {
        let _ = create(f, DAO, name, 5 * NEAR);
        env_callback(PromiseResult::Successful(b"{}".to_vec()));
        let _ = f.on_dao_checked(guard_id(name), id(DAO), U128(5 * NEAR), U128(4 * NEAR), json!({}));
        deployed(name)
    };
    assert_eq!(make(&mut f, "before"), CODE);
    env_as(FACTORY, 0);
    f.set_guard_code(NEW_CODE.to_vec());
    assert_eq!(make(&mut f, "after"), NEW_CODE, "new Guards get the new code");
    assert_eq!(f.get_guard(guard_id("before")).map(|g| g.dao_id), Some(id(DAO)), "the registry is untouched");
}

/// `publish_guard_code_global` and its callback, as if the publish succeeded (or not).
fn publish(f: &mut Factory, ok: bool) -> bool {
    env_as(FACTORY, 0);
    let _ = f.publish_guard_code_global();
    env_callback(if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
    f.on_guard_code_published(f.get_code_hash())
}

fn guard_actions(name: &str) -> Vec<MockAction> {
    get_created_receipts().into_iter().filter(|r| r.receiver_id == guard_id(name)).flat_map(|r| r.actions).collect()
}

fn metadata_code_storage(f: &Factory) -> u128 {
    f.kd_factory_metadata()["guard_code_storage"].as_str().unwrap().parse().unwrap()
}

#[test]
fn publish_puts_the_stored_code_on_the_factory_as_a_global_contract_by_hash() {
    let mut f = factory();
    env_as(FACTORY, 0);
    let _ = f.publish_guard_code_global();
    let actions: Vec<MockAction> =
        get_created_receipts().into_iter().filter(|r| r.receiver_id == id(FACTORY)).flat_map(|r| r.actions).collect();
    let published = actions.iter().find_map(|a| match a {
        MockAction::DeployGlobalContract { code, mode, .. } => Some((code.clone(), format!("{mode:?}"))),
        _ => None,
    });
    // By hash, not by account id: nobody, the factory included, can later swap the code a Guard points at.
    assert_eq!(published, Some((CODE.to_vec(), "CodeHash".to_string())));
    assert!(!f.kd_factory_metadata()["guard_code_global"].as_bool().unwrap(), "only the callback turns it on");
}

#[test]
fn after_a_publish_new_guards_use_the_global_code_and_lock_only_its_hash() {
    // 200 KB of code would lock 2 NEAR on each Guard as a copy.
    env_as(FACTORY, 0);
    let mut f = Factory::new(vec![0; 200_000]);
    let copy_cost = metadata_code_storage(&f);
    assert_eq!(copy_cost, 2 * NEAR);
    assert!(publish(&mut f, true));
    assert!(get_logs().iter().any(|l| l.contains("guard_code_published")));
    let meta = f.kd_factory_metadata();
    assert_eq!(meta["guard_code_global"], true);
    // The dashboard adds this to the deposit, so the cost it shows drops with it.
    assert_eq!(metadata_code_storage(&f), 32 * 10u128.pow(19));

    // 1 NEAR was refused before the publish (2 NEAR of code plus the 0.5 floor); now it is enough.
    let _ = create(&mut f, DAO, "acme", NEAR);
    env_callback(PromiseResult::Successful(b"{}".to_vec()));
    let _ = f.on_dao_checked(guard_id("acme"), id(DAO), U128(NEAR), U128(NEAR - NEAR / 100), json!({}));
    let actions = guard_actions("acme");
    let hash = String::from(&Base58CryptoHash::from(env::sha256_array(vec![0u8; 200_000])));
    assert!(
        actions.iter().any(|a| matches!(a, MockAction::UseGlobalContract { contract_id, .. } if format!("{contract_id:?}").contains(&hash))),
        "{actions:?}"
    );
    assert!(!actions.iter().any(|a| matches!(a, MockAction::DeployContract { .. })), "no copy of the code");
    assert!(actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })));
    assert!(
        !actions.iter().any(|a| matches!(a, MockAction::AddKeyWithFullAccess { .. } | MockAction::AddKeyWithFunctionCall { .. })),
        "still locked from birth"
    );
}

#[test]
fn a_failed_publish_keeps_new_guards_on_their_own_copy() {
    let mut f = factory();
    assert!(!publish(&mut f, false));
    assert_eq!(f.kd_factory_metadata()["guard_code_global"], false);
    assert_eq!(metadata_code_storage(&f), CODE.len() as u128 * 10u128.pow(19));
}

#[test]
fn a_publish_that_lands_after_set_guard_code_does_not_switch_to_the_old_code() {
    // The callback carries the hash it published; code replaced in between must not be marked global.
    let mut f = factory();
    let old = f.get_code_hash();
    env_as(FACTORY, 0);
    f.set_guard_code(b"\0asm guard v2".to_vec());
    env_callback(PromiseResult::Successful(vec![]));
    assert!(!f.on_guard_code_published(old));
    assert_eq!(f.kd_factory_metadata()["guard_code_global"], false);
}

#[test]
fn set_guard_code_after_a_publish_goes_back_to_copies_until_the_new_code_is_published() {
    let mut f = factory();
    assert!(publish(&mut f, true));
    env_as(FACTORY, 0);
    f.set_guard_code(b"\0asm guard v2".to_vec());
    assert_eq!(f.kd_factory_metadata()["guard_code_global"], false);
    let _ = create(&mut f, DAO, "acme", 3 * NEAR);
    env_callback(PromiseResult::Successful(b"{}".to_vec()));
    let _ = f.on_dao_checked(guard_id("acme"), id(DAO), U128(3 * NEAR), U128(2 * NEAR), json!({}));
    assert!(guard_actions("acme").iter().any(|a| matches!(a, MockAction::DeployContract { code, .. } if code == b"\0asm guard v2")));
}
