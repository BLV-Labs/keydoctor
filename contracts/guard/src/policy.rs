// Pure Guard rules (docs/final-idea.md §11.5.4, §11.5.6, §11.5.7): no storage, no promises, so every rule is
// unit-tested without a chain.
use crate::types::{Decision, GuardPolicy, PlanAction, PlanInput, RequestStatus, WhitelistEntry};
use near_sdk::AccountId;

pub const DAY_NS: u64 = 86_400 * 1_000_000_000;
pub const MEMO_MAX_CHARS: usize = 200;
/// Ids of plan steps start with this, so no agent can take the id of a step that is still to come.
pub const PLAN_REQUEST_PREFIX: &str = "plan-";
/// Longer than a step takes from first receipt to last callback, so a run in flight cannot overlap the next one.
pub const MIN_PLAN_INTERVAL_SEC: u32 = 60;
pub const MAX_STRATEGY_ID_CHARS: usize = 64;
pub const MAX_PLAN_ARGS_BYTES: usize = 2048;
/// Inside `act_proposal`'s 80 Tgas, with room for the DAO's own work.
pub const MAX_PLAN_CALL_GAS: u64 = 50_000_000_000_000;

/// Slippage choices of the DCA form (0.5 / 1 / 2 %).
pub const SWAP_SLIPPAGE_BPS: [u16; 3] = [50, 100, 200];

/// `(wrap, exchange)` of the Guard's network, from its own account suffix. The keeper passes only a plan id, so
/// nobody but this constant picks the contracts a swap calls. `None` off testnet: no swap there.
pub fn dex_for(guard: &AccountId) -> Option<(&'static str, &'static str)> {
    guard.as_str().ends_with(".testnet").then_some(("wrap.testnet", "ref-finance-101.testnet"))
}

/// Auto when every condition holds, otherwise Pending with the full list of reasons, in spec order.
pub fn decide(p: &GuardPolicy, wl: Option<&WhitelistEntry>, spent: u128, amount: u128) -> (Decision, Vec<String>) {
    let mut reasons = vec![];
    if wl.is_none() {
        reasons.push("NOT_WHITELISTED");
    }
    if amount > p.max_per_tx.0 {
        reasons.push("OVER_PER_TX");
    }
    if let Some(cap) = wl.and_then(|w| w.max_per_tx) {
        if amount > cap.0 {
            reasons.push("OVER_RECIPIENT_LIMIT");
        }
    }
    if spent.saturating_add(amount) > p.max_per_day.0 {
        reasons.push("OVER_DAILY_LIMIT");
    }
    let decision = if reasons.is_empty() { Decision::Auto } else { Decision::Pending };
    (decision, reasons.into_iter().map(String::from).collect())
}

pub const HOUR_NS: u64 = 3_600 * 1_000_000_000;

/// Self-approved yoctoNEAR per hour (`block_timestamp / HOUR_NS`), oldest first: the rolling 24 h window (red-team
/// M4). A fixed window that restarts at the first request after 24 h let twice `max_per_day` leave in a few minutes
/// across the restart. At most 25 hours are live, so the list stays small.
pub type Spends = Vec<(u32, u128)>;

fn hour_of(ns: u64) -> u32 {
    (ns / HOUR_NS) as u32
}

/// A spend counts until the hour 25 hours after its own starts, so every 24 h span that holds it sees it: the limit
/// errs on the safe side by up to one hour.
fn live(hour: u32, now: u64) -> bool {
    hour_of(now) <= hour.saturating_add(24)
}

pub fn prune(spends: &mut Spends, now: u64) {
    spends.retain(|&(hour, _)| live(hour, now));
}

/// What counts against the daily limit at `now`.
pub fn spent(spends: &Spends, now: u64) -> u128 {
    spends.iter().filter(|&&(hour, _)| live(hour, now)).fold(0u128, |sum, &(_, a)| sum.saturating_add(a))
}

pub fn add_spend(spends: &mut Spends, now: u64, amount: u128) {
    prune(spends, now);
    let hour = hour_of(now);
    match spends.last_mut() {
        Some((h, a)) if *h == hour => *a = a.saturating_add(amount),
        _ => spends.push((hour, amount)),
    }
}

/// Gives back `amount` spent at `created_at`, if that spend still counts. Returns whether it did. A spend that
/// already dropped out of the window has nothing left to give back.
pub fn refund_spend(spends: &mut Spends, created_at: u64, now: u64, amount: u128) -> bool {
    prune(spends, now);
    let hour = hour_of(created_at);
    let Some(i) = spends.iter().position(|&(h, _)| h == hour) else {
        return false;
    };
    spends[i].1 = spends[i].1.saturating_sub(amount);
    if spends[i].1 == 0 {
        spends.remove(i);
    }
    true
}

/// When the oldest spend that still counts drops out, freeing part of the limit; `now` when nothing counts.
pub fn frees_at(spends: &Spends, now: u64) -> u64 {
    spends
        .iter()
        .find(|&&(hour, _)| live(hour, now))
        .map_or(now, |&(hour, _)| (hour as u64 + 25).saturating_mul(HOUR_NS))
}

/// 8 to 64 chars of `[A-Za-z0-9_-]`, outside the prefix plan steps use. The id goes into the proposal description,
/// so it cannot hold spaces.
pub fn valid_request_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !id.starts_with(PLAN_REQUEST_PREFIX)
}

/// At most 200 chars on one line, so the description stays one parseable line.
pub fn clean_memo(memo: &str) -> String {
    memo.chars().take(MEMO_MAX_CHARS).map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// §11.5.6. `memo` is last: readers must take the other fields from before ` memo=`.
pub fn description(request_id: &str, agent: &str, decision: Decision, reasons: &[String], memo: &str) -> String {
    let decision = match decision {
        Decision::Auto => "auto",
        Decision::Pending => "pending",
    };
    let reasons = if reasons.is_empty() { "-".to_string() } else { reasons.join(",") };
    format!("[KD-GUARD] request={request_id} agent={agent} decision={decision} reasons={reasons} memo={memo}")
}

/// Final request status for a Sputnik proposal status, or `None` while it is still open.
/// Sputnik only writes `Expired` when someone acts on the proposal, so an `InProgress` proposal past its
/// period counts as expired here: no vote can pass it any more.
pub fn final_status(dao_status: &str, submission_time: u64, period: u64, now: u64) -> Option<RequestStatus> {
    match dao_status {
        "Approved" => Some(RequestStatus::Executed),
        "Rejected" | "Removed" => Some(RequestStatus::Rejected),
        "Expired" => Some(RequestStatus::Expired),
        "Failed" | "Moved" => Some(RequestStatus::Failed),
        "InProgress" if period > 0 && now >= submission_time.saturating_add(period) => Some(RequestStatus::Expired),
        _ => None,
    }
}

/// The shape of a plan, apart from the limits (`plan_reasons`). The factory is the Guard's parent account. A `call`
/// on the Guard, its DAO or its factory could change the rules, so no plan may hold one (§11.11.2).
pub fn check_plan(plan: &PlanInput, guard: &AccountId, dao: &AccountId, factory: Option<&str>) -> Result<(), &'static str> {
    if plan.amount_per_run.0 == 0 {
        return Err("INVALID_AMOUNT");
    }
    if plan.runs_total == 0 {
        return Err("INVALID_RUNS");
    }
    if plan.interval_sec < MIN_PLAN_INTERVAL_SEC {
        return Err("INTERVAL_TOO_SHORT");
    }
    if !plan.token_in.is_empty() {
        return Err("TOKEN_NOT_SUPPORTED");
    }
    if plan.strategy_id.chars().count() > MAX_STRATEGY_ID_CHARS {
        return Err("STRATEGY_ID_TOO_LONG");
    }
    if let PlanAction::Call { target, method, args_base64, deposit, gas } = &plan.action {
        if target == guard || target == dao || factory == Some(target.as_str()) {
            return Err("PLAN_TARGET_FORBIDDEN");
        }
        if method.is_empty() || method.len() > MAX_STRATEGY_ID_CHARS {
            return Err("INVALID_METHOD");
        }
        if args_base64.0.len() > MAX_PLAN_ARGS_BYTES {
            return Err("CALL_ARGS_TOO_LONG");
        }
        // The daily limit counts `amount_per_run`, so more NEAR than that must not leave.
        if deposit.0 > plan.amount_per_run.0 {
            return Err("CALL_DEPOSIT_OVER_AMOUNT");
        }
        if gas.0 == 0 || gas.0 > MAX_PLAN_CALL_GAS {
            return Err("INVALID_CALL_GAS");
        }
    }
    // A swap with no floor of its own takes whatever price a quote gives, and anyone can skew the quote (ADR 0007).
    if let PlanAction::Swap { .. } = &plan.action {
        return Err("PRICE_FLOOR_REQUIRED");
    }
    if let PlanAction::SwapWithFloor { token_out, max_slippage_bps, min_out_per_near, .. } = &plan.action {
        let Some((wrap, exchange)) = dex_for(guard) else {
            return Err("SWAP_NOT_SUPPORTED");
        };
        if !SWAP_SLIPPAGE_BPS.contains(max_slippage_bps) {
            return Err("INVALID_SLIPPAGE");
        }
        let t = token_out.as_str();
        if t == wrap || t == exchange || token_out == guard || token_out == dao || factory == Some(t) {
            return Err("INVALID_TOKEN_OUT");
        }
        if min_out_per_near.0 == 0 {
            return Err("INVALID_PRICE_FLOOR");
        }
    }
    Ok(())
}

const YOCTO_PER_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// `amount * min_out_per_near / 10^24`, rounded down: the least `token_out` the DAO takes for `amount` yoctoNEAR.
/// Exact on the full 256-bit product, since 1e9 NEAR at 10 USDT (6 decimals) already passes `u128::MAX`. `None` when
/// the answer does not fit a `u128`: no swap can return that much, so the floor cannot be met.
pub fn dao_floor(amount: u128, min_out_per_near: u128) -> Option<u128> {
    const LO: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (amount >> 64, amount & LO, min_out_per_near >> 64, min_out_per_near & LO);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & LO) + (p10 & LO);
    let lo = (p00 & LO) | ((mid & LO) << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    // The quotient fits 128 bits only when the high half is below the divisor.
    if hi >= YOCTO_PER_NEAR {
        return None;
    }
    // Long division of (hi, lo) by 10^24 one bit at a time; the remainder stays below 2^81.
    let (mut rem, mut q) = (hi, 0u128);
    for bit in (0..128).rev() {
        rem = (rem << 1) | ((lo >> bit) & 1);
        q <<= 1;
        if rem >= YOCTO_PER_NEAR {
            rem -= YOCTO_PER_NEAR;
            q |= 1;
        }
    }
    Some(q)
}

/// The agent limits, which hold for a plan too. A `call` or `swap` has no receiver to whitelist.
pub fn plan_reasons(p: &GuardPolicy, action: &PlanAction, wl: Option<&WhitelistEntry>, spent: u128, amount: u128) -> Vec<String> {
    let (_, mut reasons) = decide(p, wl, spent, amount);
    if matches!(action, PlanAction::Call { .. } | PlanAction::Swap { .. } | PlanAction::SwapWithFloor { .. }) {
        reasons.retain(|r| r != "NOT_WHITELISTED");
    }
    reasons
}

/// The first slot after `now` on the plan's grid. A late step jumps past the slots it missed: they do not run in a
/// burst, and the plan ends later instead.
pub fn next_run(due: u64, interval_sec: u32, now: u64) -> u64 {
    let interval = interval_sec as u64 * 1_000_000_000;
    let slots = now.saturating_sub(due) / interval + 1;
    due.saturating_add(slots.saturating_mul(interval))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn policy() -> GuardPolicy {
        GuardPolicy {
            max_per_tx: U128(5 * NEAR),
            max_per_day: U128(20 * NEAR),
            max_pending_per_agent: 3,
            min_reserve: U128(NEAR / 2),
        }
    }

    fn listed(cap: Option<u128>) -> WhitelistEntry {
        WhitelistEntry { label: "vendor".into(), max_per_tx: cap.map(U128) }
    }

    fn reasons(wl: Option<&WhitelistEntry>, spent: u128, amount: u128) -> Vec<String> {
        decide(&policy(), wl, spent, amount).1
    }

    #[test]
    fn within_every_limit_is_auto() {
        // The happy path: the Guard pays without a human only when all four conditions hold.
        assert_eq!(decide(&policy(), Some(&listed(None)), 0, 5 * NEAR), (Decision::Auto, vec![]));
    }

    #[test]
    fn each_reason_alone_makes_it_pending() {
        // Removing any one check would let that kind of request through without the council.
        assert_eq!(reasons(None, 0, NEAR), ["NOT_WHITELISTED"]);
        assert_eq!(reasons(Some(&listed(None)), 0, 5 * NEAR + 1), ["OVER_PER_TX"]);
        assert_eq!(reasons(Some(&listed(Some(NEAR))), 0, NEAR + 1), ["OVER_RECIPIENT_LIMIT"]);
        assert_eq!(reasons(Some(&listed(None)), 16 * NEAR, 4 * NEAR + 1), ["OVER_DAILY_LIMIT"]);
        let (decision, _) = decide(&policy(), None, 0, NEAR);
        assert_eq!(decision, Decision::Pending);
    }

    #[test]
    fn combined_reasons_are_all_listed_in_spec_order() {
        // The council reads every broken rule, not just the first (§11.5.4).
        assert_eq!(reasons(None, 0, 500 * NEAR), ["NOT_WHITELISTED", "OVER_PER_TX", "OVER_DAILY_LIMIT"]);
        assert_eq!(
            reasons(Some(&listed(Some(NEAR))), 19 * NEAR, 6 * NEAR),
            ["OVER_PER_TX", "OVER_RECIPIENT_LIMIT", "OVER_DAILY_LIMIT"]
        );
    }

    #[test]
    fn daily_limit_is_inclusive_and_cannot_overflow() {
        // Spending exactly the daily cap is allowed; a huge amount must not wrap past the check.
        assert_eq!(reasons(Some(&listed(None)), 15 * NEAR, 5 * NEAR), Vec::<String>::new());
        assert!(reasons(Some(&listed(None)), 10 * NEAR, u128::MAX).contains(&"OVER_DAILY_LIMIT".to_string()));
    }

    const H0: u64 = 500_000 * HOUR_NS;

    #[test]
    fn no_24_hours_can_hold_more_than_the_limit_across_the_old_reset() {
        // Red-team M4: the fixed window let 20 NEAR leave just before its reset and 20 more just after. A rolling
        // window still counts the first 20 a minute later, and frees them only once 24 h have passed.
        let mut s = Spends::new();
        add_spend(&mut s, H0 + DAY_NS - 60_000_000_000, 20 * NEAR);
        assert_eq!(spent(&s, H0 + DAY_NS + 60_000_000_000), 20 * NEAR, "a minute after the old reset");
        assert_eq!(spent(&s, H0 + 2 * DAY_NS - 61_000_000_000), 20 * NEAR, "still inside its own 24 h");
        assert_eq!(spent(&s, H0 + 2 * DAY_NS + HOUR_NS), 0, "out once its hour is 25 h old");
    }

    #[test]
    fn a_spend_counts_for_24_to_25_hours_never_less() {
        // Hour buckets round the expiry up, never down: a spend late in its hour counts a little over 24 h.
        let mut s = Spends::new();
        add_spend(&mut s, H0 + HOUR_NS - 1, 7);
        assert_eq!(spent(&s, H0 + HOUR_NS - 1 + DAY_NS), 7, "exactly 24 h later");
        assert_eq!(spent(&s, H0 + 25 * HOUR_NS), 0, "first ns of the 25th hour after");
        assert_eq!(frees_at(&s, H0), H0 + 25 * HOUR_NS);
        assert_eq!(frees_at(&Spends::new(), H0), H0, "nothing counts: nothing to wait for");
    }

    #[test]
    fn spends_in_one_hour_share_a_bucket_and_old_ones_are_dropped() {
        // The state stays at most 25 entries however many requests run.
        let mut s = Spends::new();
        for m in 0..60 {
            add_spend(&mut s, H0 + m * 60_000_000_000, 1);
        }
        assert_eq!(s, vec![(500_000, 60)]);
        for h in 1..=40u64 {
            add_spend(&mut s, H0 + h * HOUR_NS, 1);
        }
        assert_eq!(s.len(), 25);
        assert_eq!(s[0].0, 500_016);
    }

    #[test]
    fn a_refund_comes_off_its_own_hour_and_only_while_it_counts() {
        // A refund into a later hour would free room the failed request never took; after expiry there is none left.
        let mut s = Spends::new();
        add_spend(&mut s, H0, 5);
        add_spend(&mut s, H0 + HOUR_NS, 3);
        assert!(refund_spend(&mut s, H0 + 10, H0 + 2 * HOUR_NS, 5));
        assert_eq!(s, vec![(500_001, 3)], "an emptied hour is removed");
        assert!(!refund_spend(&mut s, H0, H0 + 2 * HOUR_NS, 5), "nothing left in that hour");
        assert_eq!(spent(&s, H0 + 2 * HOUR_NS), 3, "the other hour is untouched");
        assert!(!refund_spend(&mut s, H0 + HOUR_NS, H0 + 26 * HOUR_NS, 3), "expired");
        assert_eq!(spent(&s, H0 + 26 * HOUR_NS), 0);
    }

    #[test]
    fn request_id_length_and_charset() {
        // 8 and 64 are the inclusive bounds; a space would break the description format.
        assert!(valid_request_id(&"a".repeat(8)));
        assert!(valid_request_id(&"a".repeat(64)));
        assert!(!valid_request_id(&"a".repeat(7)));
        assert!(!valid_request_id(&"a".repeat(65)));
        assert!(valid_request_id("7c1e9f2a-0b5d-4a51-9a1e-2f3c4d5e6f70"));
        assert!(!valid_request_id("abcd efgh"));
    }

    #[test]
    fn memo_is_one_line_of_at_most_200_chars() {
        // A newline in the memo could fake a second description line for a human reader.
        assert_eq!(clean_memo("pay\ninvoice\t4"), "pay invoice 4");
        assert_eq!(clean_memo(&"é".repeat(250)).chars().count(), 200);
    }

    #[test]
    fn description_matches_the_fixed_format() {
        // checkProposals (GĐ20) parses this line; changing it breaks the Telegram alert.
        let r = vec!["NOT_WHITELISTED".to_string(), "OVER_DAILY_LIMIT".to_string()];
        assert_eq!(
            description("req-0001", "agent.testnet", Decision::Pending, &r, "invoice 4"),
            "[KD-GUARD] request=req-0001 agent=agent.testnet decision=pending reasons=NOT_WHITELISTED,OVER_DAILY_LIMIT memo=invoice 4"
        );
        assert_eq!(
            description("req-0001", "agent.testnet", Decision::Auto, &[], ""),
            "[KD-GUARD] request=req-0001 agent=agent.testnet decision=auto reasons=- memo="
        );
    }

    #[test]
    fn dao_statuses_map_to_final_request_statuses() {
        assert_eq!(final_status("Approved", 0, 10, 5), Some(RequestStatus::Executed));
        assert_eq!(final_status("Rejected", 0, 10, 5), Some(RequestStatus::Rejected));
        assert_eq!(final_status("Removed", 0, 10, 5), Some(RequestStatus::Rejected));
        assert_eq!(final_status("Expired", 0, 10, 5), Some(RequestStatus::Expired));
        assert_eq!(final_status("Failed", 0, 10, 5), Some(RequestStatus::Failed));
        assert_eq!(final_status("InProgress", 0, 10, 9), None);
    }

    #[test]
    fn in_progress_past_its_period_is_expired() {
        // Otherwise an ignored proposal holds the agent's pending slot forever.
        assert_eq!(final_status("InProgress", 100, 10, 110), Some(RequestStatus::Expired));
        assert_eq!(final_status("InProgress", 100, 0, u64::MAX), None, "unknown period: never guess expiry");
    }

    fn plan(action: PlanAction) -> PlanInput {
        PlanInput {
            action,
            strategy_id: "dca".into(),
            token_in: "".into(),
            amount_per_run: U128(NEAR),
            interval_sec: 60,
            runs_total: 3,
            start_at: near_sdk::json_types::U64(0),
        }
    }

    fn call_to(target: &str) -> PlanAction {
        PlanAction::Call {
            target: target.parse().unwrap(),
            method: "deposit".into(),
            args_base64: vec![].into(),
            deposit: U128(0),
            gas: near_sdk::json_types::U64(MAX_PLAN_CALL_GAS),
        }
    }

    fn check(p: &PlanInput) -> Result<(), &'static str> {
        let (guard, dao) = ("g.factory.testnet".parse().unwrap(), "dao.testnet".parse().unwrap());
        check_plan(p, &guard, &dao, Some("factory.testnet"))
    }

    #[test]
    fn a_plan_cannot_call_what_sets_its_own_rules() {
        // A `call` on these three could lift the limits or replace the Guard, with no owner vote on the step.
        for target in ["g.factory.testnet", "dao.testnet", "factory.testnet"] {
            assert_eq!(check(&plan(call_to(target))), Err("PLAN_TARGET_FORBIDDEN"), "{target}");
        }
        assert_eq!(check(&plan(call_to("pool.testnet"))), Ok(()));
    }

    #[test]
    fn a_call_cannot_send_more_than_the_limit_counts() {
        // The daily limit adds `amount_per_run`: a bigger deposit would leave the DAO uncounted.
        let mut action = call_to("pool.testnet");
        let PlanAction::Call { deposit, .. } = &mut action else { unreachable!() };
        *deposit = U128(NEAR + 1);
        assert_eq!(check(&plan(action)), Err("CALL_DEPOSIT_OVER_AMOUNT"));
    }

    #[test]
    fn a_call_must_fit_the_gas_of_the_guards_vote() {
        // It runs inside act_proposal: more gas than that holds could never succeed, and would fail every run.
        for bad in [0, MAX_PLAN_CALL_GAS + 1] {
            let mut action = call_to("pool.testnet");
            let PlanAction::Call { gas, .. } = &mut action else { unreachable!() };
            *gas = near_sdk::json_types::U64(bad);
            assert_eq!(check(&plan(action)), Err("INVALID_CALL_GAS"));
        }
    }

    #[test]
    fn plan_shape_is_refused_with_its_own_code() {
        let transfer = PlanAction::Transfer { receiver_id: "vendor.testnet".parse().unwrap() };
        let with = |f: fn(&mut PlanInput)| {
            let mut p = plan(transfer.clone());
            f(&mut p);
            check(&p)
        };
        assert_eq!(with(|_| ()), Ok(()));
        assert_eq!(with(|p| p.amount_per_run = U128(0)), Err("INVALID_AMOUNT"));
        assert_eq!(with(|p| p.runs_total = 0), Err("INVALID_RUNS"));
        assert_eq!(with(|p| p.interval_sec = MIN_PLAN_INTERVAL_SEC - 1), Err("INTERVAL_TOO_SHORT"));
        // Tokens wait for GĐ23: the limits are in NEAR, so a token amount would be counted as NEAR.
        assert_eq!(with(|p| p.token_in = "usdc.testnet".into()), Err("TOKEN_NOT_SUPPORTED"));
        assert_eq!(with(|p| p.strategy_id = "x".repeat(65)), Err("STRATEGY_ID_TOO_LONG"));

        let mut long = plan(call_to("pool.testnet"));
        let PlanAction::Call { args_base64, .. } = &mut long.action else { unreachable!() };
        *args_base64 = vec![0; MAX_PLAN_ARGS_BYTES + 1].into();
        assert_eq!(check(&long), Err("CALL_ARGS_TOO_LONG"));
        let mut no_method = plan(call_to("pool.testnet"));
        let PlanAction::Call { method: m, .. } = &mut no_method.action else { unreachable!() };
        m.clear();
        assert_eq!(check(&no_method), Err("INVALID_METHOD"));
    }

    #[test]
    fn a_call_has_no_receiver_to_whitelist_but_keeps_every_other_limit() {
        let call = call_to("pool.testnet");
        assert!(plan_reasons(&policy(), &call, None, 0, NEAR).is_empty());
        assert_eq!(plan_reasons(&policy(), &call, None, 0, 6 * NEAR), ["OVER_PER_TX"]);
        let transfer = PlanAction::Transfer { receiver_id: "vendor.testnet".parse().unwrap() };
        assert_eq!(plan_reasons(&policy(), &transfer, None, 0, NEAR), ["NOT_WHITELISTED"]);
    }

    fn swap_to(token_out: &str, bps: u16) -> PlanAction {
        PlanAction::SwapWithFloor { pool_id: 57, token_out: token_out.parse().unwrap(), max_slippage_bps: bps, min_out_per_near: U128(8_500_000) }
    }

    #[test]
    fn a_swap_without_a_dao_floor_is_refused_since_a_quote_alone_can_be_skewed() {
        // ADR 0007, 2026-11-12: anyone can run a step, so a quote-only bound lets them sandwich the sale. The old shape
        // stays readable for stored plans but no new plan may use it, on any network.
        let old = plan(PlanAction::Swap { pool_id: 57, token_out: "usdt.fakes.testnet".parse().unwrap(), max_slippage_bps: 100 });
        assert_eq!(check(&old), Err("PRICE_FLOOR_REQUIRED"));
        let (guard, dao) = ("g.factory.near".parse().unwrap(), "dao.testnet".parse().unwrap());
        assert_eq!(check_plan(&old, &guard, &dao, None), Err("PRICE_FLOOR_REQUIRED"));
    }

    #[test]
    fn a_zero_floor_is_refused_because_it_is_no_floor_at_all() {
        let mut zero = plan(swap_to("usdt.fakes.testnet", 100));
        let PlanAction::SwapWithFloor { min_out_per_near, .. } = &mut zero.action else { unreachable!() };
        *min_out_per_near = U128(0);
        assert_eq!(check(&zero), Err("INVALID_PRICE_FLOOR"));
        let mut one = zero.clone();
        let PlanAction::SwapWithFloor { min_out_per_near, .. } = &mut one.action else { unreachable!() };
        *min_out_per_near = U128(1);
        assert_eq!(check(&one), Ok(()), "any floor above 0 is the DAO's call");
    }

    #[test]
    fn the_dao_floor_is_exact_where_the_plain_product_would_overflow() {
        // A rounding or overflow error here moves the line between a run and a skip, so the values come from
        // Python's exact integers.
        assert_eq!(dao_floor(NEAR / 10, 8_500_000), Some(850_000));
        assert_eq!(dao_floor(123_456_789_012_345_678_901_234_567, 987_654_321_098_765), Some(121_932_631_137_021_741));
        // 1e9 NEAR at 10 USDT: the product passes u128::MAX, the answer does not.
        assert_eq!(dao_floor(1_000_000_000 * NEAR, 10_000_000), Some(10_000_000_000_000_000));
        assert_eq!(dao_floor(u128::MAX, NEAR), Some(u128::MAX));
        assert_eq!(dao_floor(u128::MAX, NEAR - 1), Some(340_282_366_920_938_463_463_374_267_149_401_290_516));
        assert_eq!(dao_floor(u128::MAX, NEAR + 1), None, "an answer over u128 cannot be met by any swap");
        assert_eq!(dao_floor(u128::MAX, u128::MAX), None);
        assert_eq!(dao_floor(0, u128::MAX), Some(0));
        assert_eq!(dao_floor(NEAR - 1, 1), Some(0), "rounded down");
    }

    #[test]
    fn a_swap_is_a_testnet_feature_and_a_plan_for_it_is_refused_anywhere_else() {
        // D9: `dex_for` is the only place the exchange ids live, so a Guard off testnet has no exchange to call and
        // must refuse at create time instead of failing every run.
        let swap = plan(swap_to("usdt.fakes.testnet", 100));
        assert_eq!(check(&swap), Ok(()));
        let (guard, dao) = ("g.factory.near".parse().unwrap(), "dao.sputnik-dao.near".parse().unwrap());
        assert_eq!(check_plan(&swap, &guard, &dao, Some("factory.near")), Err("SWAP_NOT_SUPPORTED"));
        // The other actions do not depend on the network.
        let transfer = plan(PlanAction::Transfer { receiver_id: "vendor.near".parse().unwrap() });
        assert_eq!(check_plan(&transfer, &guard, &dao, Some("factory.near")), Ok(()));
        assert_eq!(dex_for(&guard), None);
        assert_eq!(dex_for(&"g.factory.testnet".parse().unwrap()), Some(("wrap.testnet", "ref-finance-101.testnet")));
    }

    #[test]
    fn a_swap_slippage_is_one_of_the_three_choices_of_the_form() {
        // The dashboard offers 0.5 / 1 / 2 %. Any other value is a hand-made plan, and 10000 would make
        // `min_amount_out` zero: no protection at all.
        for ok in [50, 100, 200] {
            assert_eq!(check(&plan(swap_to("usdt.fakes.testnet", ok))), Ok(()), "{ok}");
        }
        for bad in [0, 1, 49, 51, 99, 150, 201, 500, 10_000, u16::MAX] {
            assert_eq!(check(&plan(swap_to("usdt.fakes.testnet", bad))), Err("INVALID_SLIPPAGE"), "{bad}");
        }
    }

    #[test]
    fn a_swap_cannot_buy_the_contracts_it_trades_through_or_the_ones_that_set_the_rules() {
        // Buying wrap or the exchange token would be a loop; the Guard, the DAO and the factory are never a token.
        for t in ["wrap.testnet", "ref-finance-101.testnet", "g.factory.testnet", "dao.testnet", "factory.testnet"] {
            assert_eq!(check(&plan(swap_to(t, 100))), Err("INVALID_TOKEN_OUT"), "{t}");
        }
        assert_eq!(check(&plan(swap_to("usdt.fakes.testnet", 100))), Ok(()));
        assert_eq!(check(&plan(swap_to("wrap.testnet.x.testnet", 100))), Ok(()), "only the exact ids are refused");
    }

    #[test]
    fn a_swap_is_checked_for_network_before_slippage_and_slippage_before_token() {
        // Each code must name the first thing the owner has to fix; a wrong order would send them to the wrong field.
        let (guard, dao) = ("g.factory.near".parse().unwrap(), "dao.testnet".parse().unwrap());
        let mut all = plan(swap_to("wrap.testnet", 7));
        let PlanAction::SwapWithFloor { min_out_per_near, .. } = &mut all.action else { unreachable!() };
        *min_out_per_near = U128(0);
        assert_eq!(check_plan(&all, &guard, &dao, None), Err("SWAP_NOT_SUPPORTED"));
        assert_eq!(check(&all), Err("INVALID_SLIPPAGE"));
        let PlanAction::SwapWithFloor { max_slippage_bps, .. } = &mut all.action else { unreachable!() };
        *max_slippage_bps = 100;
        assert_eq!(check(&all), Err("INVALID_TOKEN_OUT"), "the token before the floor");
    }

    #[test]
    fn a_swap_has_no_receiver_to_whitelist_but_keeps_both_agent_limits() {
        // Same rule as a call: the receiver is the network constant. The per-tx and per-day caps still bound the NEAR
        // sold, or a DCA plan would be a way around the limits.
        let swap = swap_to("usdt.fakes.testnet", 100);
        assert!(plan_reasons(&policy(), &swap, None, 0, NEAR).is_empty(), "no NOT_WHITELISTED");
        assert_eq!(plan_reasons(&policy(), &swap, None, 0, 6 * NEAR), ["OVER_PER_TX"]);
        assert_eq!(plan_reasons(&policy(), &swap, None, 18 * NEAR, 3 * NEAR), ["OVER_DAILY_LIMIT"]);
    }

    #[test]
    fn a_late_step_does_not_leave_a_backlog_of_slots() {
        // Runs in a burst would spend a week of budget in one cron cycle after an outage.
        const MIN: u64 = 60_000_000_000;
        assert_eq!(next_run(10 * MIN, 60, 10 * MIN), 11 * MIN, "on time: the next slot");
        assert_eq!(next_run(10 * MIN, 60, 15 * MIN + 1), 16 * MIN, "late: stays on the grid, past now");
        assert_eq!(next_run(10 * MIN, 60, 12 * MIN), 13 * MIN, "exactly on a slot: that slot is the one being run");
    }

    #[test]
    fn an_agent_cannot_take_the_id_of_a_plan_step() {
        // The ids are predictable, and a step's insert would overwrite the agent's record.
        assert!(!valid_request_id("plan-0-1800000000000000000"));
        assert!(valid_request_id("planned-payment"));
    }
}
