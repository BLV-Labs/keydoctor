// Key Doctor Guard factory (docs/guard-flow.md, Path B). A Sputnik v2 DAO calls `create` through a FunctionCall
// proposal. The factory creates `<name>.<factory>` with its own copy of the Guard code it stores, paid for by the
// calling DAO's deposit, with `dao_id` = that DAO and no access key, so the Guard is locked from birth. The registry lists which
// DAOs use a Guard. It is an index only: each Guard's own `dao_id` and `assert_dao` stay the authority.
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

mod types;

pub use types::*;

const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_ON_DAO_CHECKED: Gas = Gas::from_tgas(90);
// The Guard's `new` reads the DAO policy itself (10 + 15 Tgas static, contracts/guard/src/lib.rs).
const GAS_GUARD_NEW: Gas = Gas::from_tgas(40);
const GAS_ON_CREATED: Gas = Gas::from_tgas(15);
/// `create` checks this so a short-gassed call fails before any money moves. The dashboard attaches 150 Tgas.
const MIN_CREATE_GAS: Gas = Gas::from_tgas(120);

const MAX_GUARDS_PER_DAO: u32 = 10;
const MAX_NAME_LEN: usize = 32;
/// Least the new Guard receives on top of its code storage: room for a few proposal bonds is the caller's job;
/// this floor only stops a Guard that could not even pay for its own state.
const MIN_GUARD_BALANCE: NearToken = NearToken::from_millinear(500);
/// Raw storage key of the Guard code, kept out of the contract state so only `on_dao_checked` reads it.
const GUARD_CODE_KEY: &[u8] = b"guard_code";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Guards,
    ByDao,
    DaoGuards { dao_hash: CryptoHash },
}

#[ext_contract(ext_dao)]
#[allow(dead_code)]
trait SputnikDao {
    fn get_policy(&self) -> Value;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    /// sha256 of the Guard code (the `code_hash` every Guard account shows), fixed at init. A new Guard version
    /// means a new factory.
    guard_code_hash: CryptoHash,
    guard_code_len: u64,
    /// Guard account -> record; a record exists from `create` until the Guard is made or the attempt fails.
    guards: IterableMap<AccountId, GuardRecord>,
    by_dao: LookupMap<AccountId, IterableSet<AccountId>>,
}

#[near]
impl Factory {
    /// Stores `guard_code` and its hash. The factory account pays for that storage (0.00001 NEAR per byte, locked,
    /// not burned); every Guard pays for its own copy. Private: between the deploy and this call, anyone else could
    /// otherwise init the factory with their own Guard code.
    #[init]
    #[private]
    pub fn new(#[serializer(borsh)] guard_code: Vec<u8>) -> Self {
        let guard_code_hash: CryptoHash = env::sha256_array(&guard_code);
        env::storage_write(GUARD_CODE_KEY, &guard_code);
        Self {
            guard_code_hash,
            guard_code_len: guard_code.len() as u64,
            guards: IterableMap::new(StorageKey::Guards),
            by_dao: LookupMap::new(StorageKey::ByDao),
        }
    }

    /// Called by a DAO through a FunctionCall proposal. The caller becomes the Guard's `dao_id`, so a DAO can
    /// only create Guards for itself. The deposit, minus the registry record's storage, becomes the Guard's
    /// balance: it must cover the Guard's code storage plus MIN_GUARD_BALANCE, so the DAO pays for its own Guard.
    /// Every failure after this call returns the whole deposit to the caller.
    #[payable]
    pub fn create(
        &mut self,
        name: String,
        policy: GuardPolicy,
        agents: Vec<AgentInput>,
        whitelist: Vec<WhitelistInput>,
        guardians: Vec<AccountId>,
    ) -> Promise {
        require!(env::prepaid_gas() >= MIN_CREATE_GAS, "NOT_ENOUGH_GAS");
        validate_inputs(&agents, &whitelist, &guardians);
        let dao_id = env::predecessor_account_id();
        let guard_id = guard_account(&name);
        require!(!self.guards.contains_key(&guard_id), "NAME_TAKEN");
        require!(self.count_for(&dao_id) < MAX_GUARDS_PER_DAO, "TOO_MANY_GUARDS");

        let before = env::storage_usage();
        self.reserve(&dao_id, &guard_id, name);
        let record_cost = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        let deposit = env::attached_deposit();
        let amount = deposit.saturating_sub(record_cost);
        require!(amount >= self.code_storage().saturating_add(MIN_GUARD_BALANCE), "DEPOSIT_TOO_LOW");

        let init = json!({ "dao_id": dao_id, "policy": policy, "agents": agents, "whitelist": whitelist, "guardians": guardians });
        ext_dao::ext(dao_id.clone()).with_static_gas(GAS_VIEW).get_policy().then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_ON_DAO_CHECKED).on_dao_checked(
                guard_id,
                dao_id,
                U128(deposit.as_yoctonear()),
                U128(amount.as_yoctonear()),
                init,
            ),
        )
    }

    /// A caller without a working `get_policy` is not a DAO: drop the reservation and refund.
    #[private]
    pub fn on_dao_checked(
        &mut self,
        guard_id: AccountId,
        dao_id: AccountId,
        deposit: U128,
        amount: U128,
        init: Value,
    ) -> Promise {
        // Only success matters; a large policy is still a success (`TooLong`), so nothing is read.
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            self.release(&dao_id, &guard_id);
            return Promise::new(dao_id).transfer(NearToken::from_yoctonear(deposit.0));
        }
        let code = env::storage_read(GUARD_CODE_KEY).unwrap_or_else(|| env::panic_str("NO_GUARD_CODE"));
        Promise::new(guard_id.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(amount.0))
            .deploy_contract(code)
            .function_call("new", init.to_string().into_bytes(), NearToken::from_near(0), GAS_GUARD_NEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CREATED).on_created(guard_id, dao_id, deposit))
    }

    /// The batch is one receipt: on failure no account exists, and the transfer comes back to the factory.
    #[private]
    pub fn on_created(&mut self, guard_id: AccountId, dao_id: AccountId, deposit: U128) -> bool {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            self.release(&dao_id, &guard_id);
            Promise::new(dao_id).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            return false;
        }
        if let Some(r) = self.guards.get_mut(&guard_id) {
            r.ready = true;
        }
        emit("guard_created", json!({ "dao_id": dao_id, "guard_id": guard_id }));
        true
    }

    pub fn get_guards_for_dao(&self, dao_id: AccountId) -> Vec<GuardView> {
        self.by_dao
            .get(&dao_id)
            .map(|set| set.iter().filter_map(|g| self.view(g)).collect())
            .unwrap_or_default()
    }

    pub fn list_guards(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<GuardView> {
        self.guards
            .keys()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|g| self.view(g))
            .collect()
    }

    pub fn get_guard(&self, guard_id: AccountId) -> Option<GuardView> {
        self.view(&guard_id)
    }

    pub fn get_code_hash(&self) -> Base58CryptoHash {
        self.guard_code_hash.into()
    }

    pub fn kd_factory_metadata(&self) -> Value {
        json!({
            "standard": "kd_guard_factory",
            "version": "1.0.0",
            "guard_code_hash": Base58CryptoHash::from(self.guard_code_hash),
            "guards": self.guards.len(),
            "max_guards_per_dao": MAX_GUARDS_PER_DAO,
            "min_guard_balance": U128(MIN_GUARD_BALANCE.as_yoctonear()),
            "guard_code_storage": U128(self.code_storage().as_yoctonear()),
        })
    }
}

impl Factory {
    /// What each Guard's copy of the code locks on its own account; part of the DAO's deposit.
    fn code_storage(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(self.guard_code_len as u128)
    }

    fn count_for(&self, dao_id: &AccountId) -> u32 {
        self.by_dao.get(dao_id).map_or(0, |s| s.len())
    }

    /// Takes the name and a DAO slot before any promise, so two concurrent calls cannot both pass the checks.
    fn reserve(&mut self, dao_id: &AccountId, guard_id: &AccountId, name: String) {
        let record = GuardRecord { dao_id: dao_id.clone(), name, created_at: U64(env::block_timestamp()), ready: false };
        self.guards.insert(guard_id.clone(), record);
        self.by_dao
            .entry(dao_id.clone())
            .or_insert_with(|| IterableSet::new(StorageKey::DaoGuards { dao_hash: env::sha256_array(dao_id.as_bytes()) }))
            .insert(guard_id.clone());
    }

    fn release(&mut self, dao_id: &AccountId, guard_id: &AccountId) {
        self.guards.remove(guard_id);
        if let Some(set) = self.by_dao.get_mut(dao_id) {
            set.remove(guard_id);
            if set.is_empty() {
                self.by_dao.remove(dao_id);
            }
        }
    }

    fn view(&self, guard_id: &AccountId) -> Option<GuardView> {
        self.guards.get(guard_id).map(|r| GuardView {
            guard_id: guard_id.clone(),
            dao_id: r.dao_id.clone(),
            name: r.name.clone(),
            created_at: r.created_at,
            ready: r.ready,
        })
    }
}

/// `<name>.<factory>`; `name` is one lowercase label. `AccountId` parsing checks the separators.
fn guard_account(name: &str) -> AccountId {
    let label_ok = !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    require!(label_ok, "INVALID_NAME");
    format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("INVALID_NAME"))
}

/// NEP-297, standard `kd_guard_factory` 1.0.0.
fn emit(event: &str, data: Value) {
    let body = json!({ "standard": "kd_guard_factory", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

#[cfg(test)]
mod tests;
